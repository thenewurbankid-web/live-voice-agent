// Orchestrator: composes the blocks (brain, ears, voice, eyes, translator, map) into a live call.
import { BRAINS, defaultBrainKey, Brain } from './brain.js';
import { Ears } from './ears.js';
import { VOICES, Voice } from './voice.js';
import { Eyes } from './eyes.js';
import { Translator } from './translate.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('live:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('live:' + k, JSON.stringify(v)); } catch {} },
};

// ---------- device profile ----------
async function detectProfile() {
  const mobile = matchMedia('(pointer:coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  let webgpu = false, f16 = false;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    webgpu = !!adapter; f16 = !!adapter?.features.has('shader-f16');
  } catch {}
  return { mobile, webgpu, f16 };
}

// ---------- setup screen ----------
const profile = await detectProfile();
const chips = [
  [profile.mobile ? 'Phone profile' : 'Desktop profile', 'ok'],
  [profile.webgpu ? 'WebGPU ✓' : 'No WebGPU — AI brain needs Chrome/Edge/Safari 26+', profile.webgpu ? 'ok' : 'bad'],
  [navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'ok' : ''],
];
$('chips').innerHTML = chips.map(([t, c]) => `<span class="chip ${c}">${t}</span>`).join('');

$('brain').innerHTML = BRAINS.map((b) => `<option value="${b.key}">${b.label}</option>`).join('');
$('brain').value = store.get('brain', defaultBrainKey(profile));
$('voice').innerHTML = VOICES.map((v) => `<option value="${v.key}">${v.label}</option>`).join('');
$('voice').value = store.get('voice', 'af_heart');
$('mode').value = store.get('mode', 'chat');
$('useCam').checked = store.get('useCam', true);
$('bargeIn').checked = store.get('bargeIn', true);
const syncMode = () => { $('brain').closest('label').classList.toggle('hidden', $('mode').value !== 'chat'); };
$('mode').onchange = syncMode; syncMode();

// PWA: service worker + install hint
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvt = e;
  $('installHint').innerHTML = '<button class="ghost" id="installBtn">Install app</button>';
  $('installBtn').onclick = () => installEvt?.prompt();
});
if (/iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone)
  $('installHint').textContent = 'Install: tap Share → Add to Home Screen.';

// ---------- progress rows ----------
function progressRow(container, label) {
  const el = document.createElement('div');
  el.className = 'p';
  el.innerHTML = `<b>${label}</b> <span>waiting…</span><div class="bar"><i></i></div>`;
  container.append(el);
  return (f, text) => {
    el.querySelector('i').style.width = Math.round(Math.min(1, f || 0) * 100) + '%';
    el.querySelector('span').textContent = text || (f >= 1 ? 'ready' : Math.round(f * 100) + '%');
  };
}

// ---------- state ----------
let brain, ears, voice, eyes, translator, audioCtx, micStream, micAnalyser;
let state = 'idle', turn = 0, micOn = true, mode = 'chat', bargeIn = true;
const history = [];

function setState(s) {
  state = s;
  $('call').dataset.state = s;
  $('status').textContent = {
    listening: micOn ? 'Listening' : 'Mic muted',
    transcribing: mode === 'de-en' ? 'Translating…' : 'Hearing you…',
    thinking: 'Thinking…', looking: 'Looking…', speaking: 'Speaking · tap orb to interrupt',
  }[s] || s;
}

function caption(kind, text) {
  const box = $('captions');
  let el = box.querySelector(`.cap.${kind}:last-child`);
  if (!el || kind === 'you') {
    el = document.createElement('div'); el.className = 'cap ' + kind; box.append(el);
    while (box.children.length > 3) box.firstChild.remove();
  }
  el.textContent = text;
}
function logLine(who, text) {
  history.push({ who, text });
  const p = document.createElement('p'); p.innerHTML = `<b>${who}:</b> `; p.append(text);
  $('log').append(p);
}

// ---------- turn handling ----------
function interrupt() {
  turn++;
  brain?.interrupt();
  voice?.stop();
}

function onSpeechStart() {
  if (!micOn) return;
  if ((state === 'speaking' || state === 'thinking') && bargeIn) { interrupt(); setState('listening'); }
}

async function onUtterance(audio) {
  if (!micOn) return;
  if (state === 'speaking' && !bargeIn) return;
  const my = ++turn;
  brain?.interrupt(); voice?.stop();
  setState('transcribing');
  const opts = mode === 'de-en' ? { language: 'german', task: 'translate' } : {};
  const text = await ears.transcribe(audio, opts).catch(() => '');
  if (my !== turn) return;
  if (!text) { setState('listening'); return; }
  if (mode === 'de-en') return speakTranslation(text, my);
  return respond(text, my);
}

async function speakTranslation(english, my) {
  caption('tr', english); logLine('English', english);
  setState('speaking');
  voice.say(english);
  await voice.drain();
  if (my === turn) setState('listening');
}

// Split the streamed reply into speakable chunks so audio starts on the first sentence.
function cutPoint(s, first) {
  const re = /[.!?…]+["')\]]?\s|\n+/g;
  let m, cut = -1;
  while ((m = re.exec(s))) { cut = m.index + m[0].length; if (first) break; }
  if (cut < 0 && first && s.length > 60) { const c = s.lastIndexOf(', '); if (c > 20) cut = c + 2; }
  return cut;
}

async function respond(text, my) {
  caption('you', text); logLine('You', text);
  let image = null, scene = null;
  const frame = eyes?.enabled ? eyes.snapshot(brain.vision ? 448 : 384) : null;
  if (frame && brain.vision) image = frame;
  else if (frame && eyes.captionerReady) {
    setState('looking');
    scene = await eyes.describe(frame).catch(() => '') || null;
    if (my !== turn) return;
  }
  setState('thinking');
  let shown = '', buf = '', first = true;
  try {
    for await (const d of brain.reply(text, { image, scene })) {
      if (my !== turn) break;
      shown += d; buf += d; caption('agent', shown);
      const cut = cutPoint(buf, first);
      if (cut > 0) { voice.say(buf.slice(0, cut)); buf = buf.slice(cut); first = false; setState('speaking'); }
    }
  } catch (e) {
    if (my === turn) caption('agent', '⚠️ ' + (e.message || e));
  }
  if (my !== turn) return;
  if (buf.trim()) { voice.say(buf); setState('speaking'); }
  if (shown) logLine('AI', shown);
  await voice.drain();
  if (my === turn) setState('listening');
}

async function onTyped(text) {
  const my = ++turn;
  brain?.interrupt(); voice?.stop();
  if (mode === 'de-en') {
    caption('you', text); logLine('Deutsch', text);
    setState('transcribing');
    const en = await translator.deToEn(text).catch(() => '');
    if (my === turn && en) return speakTranslation(en, my);
    return setState('listening');
  }
  return respond(text, my);
}

// ---------- orb level meter ----------
function meter() {
  const a = state === 'speaking' ? voice?.analyser : micAnalyser;
  let lvl = 0;
  if (a) {
    const buf = new Uint8Array(a.fftSize); a.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
    lvl = Math.min(1, Math.sqrt(sum / buf.length) * 4);
  }
  $('orb').style.setProperty('--lvl', lvl.toFixed(3));
  requestAnimationFrame(meter);
}

// ---------- start ----------
async function start() {
  $('start').disabled = true; $('err').classList.add('hidden');
  mode = $('mode').value; bargeIn = $('bargeIn').checked;
  const useCam = $('useCam').checked;
  ['brain', 'voice', 'mode'].forEach((k) => store.set(k, $(k).value));
  store.set('useCam', useCam); store.set('bargeIn', bargeIn);

  // user-gesture work first (iOS)
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  voice = new Voice(audioCtx); voice.unlock();

  const prog = $('prog'); prog.innerHTML = ''; prog.classList.remove('hidden');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 512;
    audioCtx.createMediaStreamSource(micStream).connect(micAnalyser);

    eyes = new Eyes($('cam'));
    if (useCam) await eyes.open('user').catch(() => {});
    $('call').classList.toggle('nocam', !useCam || !eyes.enabled);

    ears = new Ears({ onSpeechStart, onUtterance });
    const jobs = [
      () => ears.load(micStream, profile, progressRow(prog, 'Ears · Whisper + Silero VAD')),
      () => voice.load($('voice').value, profile, progressRow(prog, 'Voice · Kokoro-82M')),
    ];
    if (mode === 'chat') {
      if (!profile.webgpu) throw new Error('This browser has no WebGPU, which the AI brain needs. Try Chrome or Edge (Android/desktop) or Safari 26+ (iPhone). Translator mode works without it.');
      brain = new Brain($('brain').value, profile);
      jobs.unshift(() => brain.load(progressRow(prog, 'Brain · ' + BRAINS.find((b) => b.key === $('brain').value)?.label)));
      if (useCam && !brain.vision) {
        const row = progressRow(prog, 'Eyes · SmolVLM-256M');
        jobs.push(() => eyes.loadCaptioner(profile, row).then(() => { eyes.captionerReady = true; }).catch(() => row(1, 'skipped (not supported here)')));
      }
    } else {
      translator = new Translator();
      jobs.push(() => translator.load(progressRow(prog, 'Translator · Opus-MT de→en')));
    }
    // Phones: load one model at a time to keep memory peaks low. Desktop: in parallel.
    if (profile.mobile) { for (const j of jobs) await j(); } else await Promise.all(jobs.map((j) => j()));

    await enterCall();
  } catch (e) {
    console.error(e);
    $('err').textContent = (e && e.message) || String(e);
    $('err').classList.remove('hidden');
    $('start').disabled = false;
  }
}

async function enterCall() {
  $('setup').classList.add('hidden'); $('call').classList.remove('hidden');
  $('modelPill').textContent = mode === 'chat' ? BRAINS.find((b) => b.key === $('brain').value)?.label.split(' ·')[0] : 'Deutsch → English';
  $('typeIn').placeholder = mode === 'de-en' ? 'Deutsch eingeben…' : 'Type a message…';
  try { await navigator.wakeLock?.request('screen'); } catch {}
  await ears.start();
  setState('listening');
  meter();
  if (mode === 'chat') { voice.say("Hi! I'm listening."); }
}

// ---------- controls ----------
$('start').onclick = start;
$('orb').onclick = () => { if (state === 'speaking' || state === 'thinking') { interrupt(); setState('listening'); } };
$('typeForm').onsubmit = (e) => { e.preventDefault(); const t = $('typeIn').value.trim(); if (!t) return; $('typeIn').value = ''; $('typeIn').blur(); onTyped(t); };
$('micBtn').onclick = async () => {
  micOn = !micOn; $('micBtn').classList.toggle('off', !micOn);
  micStream?.getAudioTracks().forEach((t) => (t.enabled = micOn));
  if (micOn) await ears.start(); else await ears.pause();
  setState(state);
};
$('camBtn').onclick = async () => {
  if (!eyes.enabled && !$('cam').srcObject) await eyes.open('user').catch(() => {});
  else eyes.setEnabled(!eyes.enabled);
  $('camBtn').classList.toggle('off', !eyes.enabled);
  $('call').classList.toggle('nocam', !eyes.enabled);
};
$('flipBtn').onclick = () => eyes?.flip().catch(() => {});
$('logBtn').onclick = () => $('logSheet').classList.remove('hidden');
$('endBtn').onclick = () => location.reload();
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('.sheet').classList.add('hidden')));

let berlin;
async function openMap() {
  $('mapSheet').classList.remove('hidden');
  if (berlin) return berlin.show();
  const prog = $('mapProg'); prog.innerHTML = '';
  try {
    const { BerlinMap } = await import('./map.js');
    berlin = new BerlinMap($('mapBox'));
    await berlin.ensureOffline(progressRow(prog, 'Berlin map data'));
    prog.innerHTML = '';
    await berlin.show();
  } catch (e) { prog.textContent = 'Map unavailable: ' + (e.message || e); berlin = null; }
}
$('mapBtn').onclick = openMap;
$('openMap').onclick = openMap;
