// Orchestrator: composes the blocks (brain, ears, voice, eyes, translator, map) into a live call.
import { BRAINS, defaultBrainKey, Brain } from './brain.js';
import { Ears } from './ears.js';
import { VOICES, Voice } from './voice.js';
import { Eyes } from './eyes.js';
import { Translator } from './translate.js';
import { GermanOCR } from './ocr.js';
import { Places, CATEGORIES } from './places.js';
import { route } from './routing.js';
import { Navigator } from './navigator.js';
import { buildPlan, replaceStop, removeStop, moveStop } from './planner.js';
import { PlansStore } from './plans-store.js';
import { PlanUI } from './plan-ui.js';
import { webSearch, needsWeb } from './web.js';
import { Memory } from './memory.js';
import { Sounds, describeSounds } from './sounds.js';
import { Aware } from './aware.js';
import { GraphMemory } from './graph-memory.js';
// Cap every startup wait so a slow phone never blocks the UI from wiring its buttons.
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
const graph = new GraphMemory();
await within(graph.load(), 3000).catch(() => { graph.events = []; graph.index = new Map(); graph.byId = new Map(); });
let sounds = null, aware = null, soundBefore = null, lastSpeechAt = 0, recorder = null;
const memory = new Memory();
await within(memory.load(), 3000).catch(() => { memory.facts = []; memory.turns = []; });
let lastAudio = null;

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
    const adapter = navigator.gpu ? await within(navigator.gpu.requestAdapter(), 2500) : null;
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
$('useWeb').checked = store.get('useWeb', true);
$('useAware').checked = store.get('useAware', true);
$('useRec').checked = store.get('useRec', false);
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
let ocr;
let brain, ears, voice, eyes, translator, audioCtx, micStream, micAnalyser;
let state = 'idle', turn = 0, micOn = true, mode = 'chat', bargeIn = true;
const history = [];

function setState(s) {
  state = s;
  $('call').dataset.state = s;
  $('status').textContent = {
    listening: micOn ? 'Listening' : 'Mic muted',
    transcribing: mode === 'chat' ? 'Hearing you…' : 'Translating…',
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
// Research sources as tappable links under the answer.
function showSources(list) {
  const box = $('captions'), el = document.createElement('div');
  el.className = 'cap src';
  for (const x of list) { const a = Object.assign(document.createElement('a'), { href: x.url, target: '_blank', rel: 'noopener', textContent: `[${x.n}] ${x.title}` }); el.append(a); }
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
}
function logLine(who, text, extra = {}) {
  history.push({ who, text });
  memory.addTurn(who, text, extra).catch(() => {});
  graph.add(who === 'You' ? 'said' : 'reply', text).catch(() => {});
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
  lastSpeechAt = Date.now();
  soundBefore = sounds?.snapshot(3) || null;   // the sound just before the user spoke ("can you hear that?")
  if ((state === 'speaking' || state === 'thinking') && bargeIn) { interrupt(); setState('listening'); }
}

async function onUtterance(audio) {
  if (!micOn) return;
  if (state === 'speaking' && !bargeIn) return;
  const my = ++turn;
  brain?.interrupt(); voice?.stop();
  lastAudio = audio;
  setState('transcribing');
  const opts = { 'de-en': { language: 'german', task: 'translate' }, 'te-en': { language: 'telugu', task: 'translate' } }[mode] || {};
  const text = await ears.transcribe(audio, opts).catch(() => '');
  if (my !== turn) return;
  if (!text) { setState('listening'); return; }
  if (mode === 'de-en' || mode === 'te-en') return speakTranslation(text, my);
  if (mode === 'en-te') return speakTelugu(text, my);
  return respond(text, my);
}

async function speakTranslation(english, my) {
  caption('tr', english); logLine('English', english);
  setState('speaking');
  voice.say(english);
  await voice.drain();
  if (my === turn) setState('listening');
}

async function speakTelugu(english, my) {
  caption('you', english); logLine('English', english);
  setState('transcribing');
  const te = await translator.enToTe(english).catch(() => '');
  if (my !== turn || !te) return setState('listening');
  caption('tr', te); logLine('తెలుగు', te);
  setState('speaking');
  if (voice.hasVoice('te-IN')) { voice.say(te, { lang: 'te-IN' }); await voice.drain(); }
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
  const graphCtx = within(graph.contextFor(text), 1200).catch(() => ''); // memory helps, but never holds up a reply
  caption('you', text);
  const visual = VISUAL_RE.test(text);
  logLine('You', text, { image: visual && eyes?.enabled ? eyes.snapshot(320) : null, audio: lastAudio });
  lastAudio = null;
  if (await handleIntent(text, my)) return;
  const asked = text;
  const mem = [memory.context(), await graphCtx].filter(Boolean).join('\n');
  if (mem) text += '\n\n(' + mem + ')';
  if (my !== turn) return;
  let sources = null;
  if (researchOn || RESEARCH_RE.test(asked)) {
    if (!getOnline()) { say('Research needs the internet. Turn on web access and ask again.', my); return; }
    setState('thinking');
    const { research, researchPrompt } = await import('./research.js');
    const r = await research(asked, { onStep: (s) => { if (my === turn) caption('agent', s + '…'); } }).catch(() => null);
    if (my !== turn) return;
    if (!r?.notes.length) { say("I couldn't find anything solid on that. Try different words?", my); return; }
    text = researchPrompt(text, r); sources = r.sources;
  } else if (getOnline() && needsWeb(text)) {
    setState('thinking');
    const hits = await webSearch(text, { limit: 3 }).catch(() => []);
    if (my !== turn) return;
    if (hits.length) text += '\n\n(Web results — answer from these, mention the source:\n' + hits.map((h) => `- ${h.title} (${h.source}): ${h.snippet}`).join('\n') + ')';
  }
  let image = null, scene = null;
  // Frames are taken only when the question is about what the camera sees: no per-turn vision cost otherwise.
  const frame = visual && eyes?.enabled ? eyes.snapshot(brain.vision ? 448 : 384) : null;
  if (frame && brain.vision) image = frame;
  else if (frame && eyes.captionerReady) {
    setState('looking');
    scene = await eyes.describe(frame).catch(() => '') || null;
    if (my !== turn) return;
  }
  setState('thinking');
  let shown = '', buf = '', first = true, lastTok = Date.now();
  // Watchdog: if the brain produces nothing for 60 s, cancel and go back to listening instead of "Thinking" forever.
  const dog = setInterval(() => { if (my === turn && Date.now() - lastTok > 60000) { clearInterval(dog); try { brain.interrupt(); } catch {} caption('agent', '⚠️ That took too long, so I stopped. Try again, or pick a smaller brain on the start screen.'); setState('listening'); } }, 3000);
  try {
    for await (const d of brain.reply(text, { image, scene })) {
      lastTok = Date.now();
      if (my !== turn) break;
      shown += d; buf += d; caption('agent', shown);
      const cut = cutPoint(buf, first);
      if (cut > 0) { voice.say(buf.slice(0, cut)); buf = buf.slice(cut); first = false; setState('speaking'); }
    }
  } catch (e) {
    if (my === turn) caption('agent', '⚠️ ' + (e.message || e));
  } finally { clearInterval(dog); }
  if (my !== turn) return;
  if (buf.trim()) { voice.say(buf); setState('speaking'); }
  if (shown) logLine('AI', shown);
  if (sources) { showSources(sources); logLine('AI', 'Sources: ' + sources.map((x) => `[${x.n}] ${x.title} ${x.url}`).join(' · ')); }
  await voice.drain();
  if (my === turn) setState('listening');
}

async function onTyped(text) {
  const my = ++turn;
  brain?.interrupt(); voice?.stop();
  if (mode === 'en-te') return speakTelugu(text, my);
  if (mode === 'de-en' || mode === 'te-en') {
    caption('you', text); logLine(mode === 'de-en' ? 'Deutsch' : 'తెలుగు', text);
    setState('transcribing');
    const en = await (mode === 'de-en' ? translator.deToEn(text) : translator.teToEn(text)).catch(() => '');
    if (my === turn && en) return speakTranslation(en, my);
    return setState('listening');
  }
  return respond(text, my);
}

// ---------- planner + places (deterministic; the LLM never invents places) ----------
let webOn = true;
// Research mode: on = every question is researched (search → read sources → answer with citations).
const RESEARCH_RE = /^(please\s+)?(can you\s+)?(do (a|some)\s+)?(research|look into|dig into|deep dive|find out about|read up on|recherchiere)\b/i;
let researchOn = false;
const VISUAL_RE = /\b(see|look|looking|watch|this|that|these|those|here|camera|picture|photo|read|sign|menu|colou?r|wearing|holding|show|what'?s (this|that)|what is (this|that)|where am i|sieh|schau|das hier)\b/i;
const getOnline = () => webOn && navigator.onLine;
const places = new Places();
const plans = new PlansStore();
let berlinForPlans, planUI;
async function getPlanUI() {
  if (planUI) return planUI;
  await openMap();               // map data + MapLibre must be up before plans draw on it
  berlinForPlans = berlin;
  await places.load();
  planUI = new PlanUI($('planSheet'), {
    places, store: plans, map: berlinForPlans, buildPlan, replaceStop, removeStop, moveStop, route, Navigator, getOnline,
    speak: (t) => voice?.say(t),
  });
  return planUI;
}
async function openPlans(view) {
  const ui = await getPlanUI();
  await openMap();
  await ui.open(view);
}

const CAT_WORDS = [
  [/\b(bars?|cocktails?|drinks?)\b/i, 'bar'], [/\b(pubs?|kneipe)\b/i, 'pub'], [/\b(clubs?|clubbing|techno|dance|party)\b/i, 'club'],
  [/\b(biergarten|beer ?gardens?)\b/i, 'biergarten'], [/\b(caf[eé]s?|coffee)\b/i, 'cafe'], [/\b(restaurants?|food|eat|dinner|lunch)\b/i, 'restaurant'],
  [/\b(museums?)\b/i, 'museum'], [/\b(sights?|attractions?|landmarks?)\b/i, 'sight'], [/\b(parks?)\b/i, 'park'],
];
const areaOf = (t) => (t.match(/\b(?:in|around|near|at|from)\s+([A-ZÄÖÜa-zäöüß][\wäöüß .-]{2,30}?)(?:[,.?!]|$|\s+(?:with|for|and|tonight|today|please))/i) || [])[1]?.trim();
const NUMS = { two: 2, three: 3, four: 4, five: 5, six: 6 };

async function handleIntent(text, my) {
  const t = text.toLowerCase();
  // 1) build a plan
  if (/\b(plan|organi[sz]e|make)\b/.test(t) && /\b(night|evening|day|tour|trip|afternoon|out)\b/.test(t)) {
    setState('thinking');
    const kind = /\b(night|evening|bar|drinks|party|club)\b/.test(t) ? 'night' : 'day';
    const n = +(t.match(/\b(\d)\s+(?:stops|places|bars)\b/) || [])[1] || NUMS[(t.match(/\b(two|three|four|five|six)\b/) || [])[1]] || 4;
    const ui = await getPlanUI();
    await ui.open('active');
    const plan = await ui.createFromVoice({ kind, startText: areaOf(text) || '', stops: n });
    if (my !== turn) return true;
    const names = plan?.stops?.map((s) => s.place.name) || [];
    say(names.length ? `Here's your ${kind === 'night' ? 'night out' : 'day'}: ${names.join(', then ')}. Tap Start when you're ready.` : `I couldn't find enough places there. Try another area.`, my);
    return true;
  }
  // A) translation inside the assistant (models load on first use, then work offline)
  const signAsk = /\b(what does (this|that|the) (sign|menu|text|label|say)|read (this|the) (sign|menu|text)|translate (this|that|what i see|the sign|the menu))\b/.test(t);
  if (signAsk) {
    const frame = eyes?.snapshot(1280);
    if (!frame) { say('Turn the camera on and point it at the text.', my); return true; }
    setState('looking');
    translator ||= new Translator();
    ocr ||= new GermanOCR();
    const [de] = await Promise.all([ocr.read(frame).catch(() => ''), translator.load().catch(() => {})]);
    if (my !== turn) return true;
    if (!de) { say("I can't read any German text there. Hold it closer and steady.", my); return true; }
    const en = await translator.deToEn(de).catch(() => '');
    say(en ? `It says: ${en}` : `I read: ${de}`, my);
    return true;
  }
  const tr = text.match(/^\s*(?:please\s+)?(?:translate|how do (?:you|i) say)\s+["“']?(.+?)["”']?\s+(?:in|into|to)\s+(german|deutsch|english|telugu)\s*[?.!]*$/i);
  if (tr) {
    const [, phrase, lang] = tr; const L = lang.toLowerCase();
    setState('thinking');
    translator ||= new Translator();
    let out = '';
    if (L === 'german' || L === 'deutsch') out = await translator.enToDe(phrase).catch(() => '');
    else if (L === 'telugu') { await translator.loadTelugu().catch(() => {}); out = await translator.enToTe(phrase).catch(() => ''); }
    else { await translator.load().catch(() => {}); out = await translator.deToEn(phrase).catch(() => ''); }
    if (my !== turn) return true;
    if (!out) { say('Sorry, I could not translate that.', my); return true; }
    caption('tr', out); logLine(lang, out);
    const code = { german: 'de-DE', deutsch: 'de-DE', telugu: 'te-IN' }[L];
    setState('speaking');
    if (code && voice.hasVoice(code)) voice.say(out, { lang: code }); else voice.say(out);
    voice.drain().then(() => { if (my === turn) setState('listening'); });
    return true;
  }
  // H) hearing: name the ambient sound
  if (/\b(can you hear|do you hear|what do you hear|hear (that|this)|what('?s| is) (that|this) (sound|noise)|what sound)\b/.test(t)) {
    if (!sounds?.clf) { say("My sound recognizer isn't loaded on this device, but I can hear your voice.", my); return true; }
    let found = describeSounds(sounds.classify(soundBefore));
    if (!found) { caption('agent', 'Listening…'); setState('looking'); found = describeSounds(await sounds.listen(3)); }
    if (my !== turn) return true;
    if (found) graph.add('heard', found).catch(() => {});
    say(found ? `I can hear ${found}.` : "I don't hear anything besides your voice right now.", my);
    return true;
  }
  // 0) persistent memory
  const rem = text.match(/^\s*(?:please\s+)?remember(?:\s+that)?\s+(.{3,})$/i);
  if (rem) { await memory.remember(rem[1].replace(/[.!]+$/, '')); say("Okay, I'll remember that.", my); return true; }
  const name = text.match(/\b(?:my name is|i am called|call me)\s+([A-ZÄÖÜa-zäöüß][\wäöüß-]{1,30})/i);
  if (name) { await memory.remember(`The user's name is ${name[1]}`); say(`Nice to meet you, ${name[1]}. I'll remember that.`, my); return true; }
  const like = text.match(/^\s*i (?:really )?(like|love|prefer|hate|don'?t like)\s+(.{3,60})$/i);
  if (like) { await memory.remember(`The user ${like[1].toLowerCase()}s ${like[2].replace(/[.!]+$/, '')}`.replace('dont likes', "doesn't like").replace("don't likes", "doesn't like")); }
  if (/\b(what do you (remember|know about me)|do you (know|remember) me|who am i|what'?s my name|do you remember)\b/.test(t)) {
    const nm = memory.facts.map((f) => f.text).reverse().find((x) => x.startsWith("The user's name is"));
    const past = memory.turns.filter((x) => x.who === 'You').length;
    say(memory.facts.length
      ? `${nm ? `Yes, you're ${nm.replace("The user's name is ", '')}. ` : ''}I remember: ` + memory.facts.map((f) => f.text.replace(/^The user/, 'you')).join('; ') + `. We've talked ${past} times.`
      : past > 1 ? `We've talked ${past} times, but you haven't told me about yourself yet. Tell me your name and I'll remember it.` : "Not yet. Tell me your name and what you like, and I'll remember it on this device.", my);
    return true;
  }
  if (/\bforget (everything|all)\b/.test(t)) { await memory.forgetAll(); await graph.clear(); if (brain) brain.history = []; say('Done. I forgot everything.', my); return true; }
  // 2) "I'm here / done / next" → finish current stop, guide to the next one
  if (/\b(i'?m here|we'?re here|arrived|done here|next place|move on|let'?s go on)\b/.test(t)) {
    const active = await plans.active() || (await plans.list())[0];
    if (!active) { say('There is no plan yet. Say: plan a night out near me.', my); return true; }
    if (active.stops[active.current]) active.stops[active.current].done = true;
    active.current = Math.min(active.current + 1, active.stops.length);
    active.status = active.current >= active.stops.length ? 'done' : 'active';
    await plans.save(active);
    if (active.status === 'done') { stopGuide(); say('That was the last stop. Great day out!', my); return true; }
    return guide(active, my);
  }
  // 3) navigation on the active plan
  if (/\b(navigate|directions|take me|next stop|how do i get|guide me|let'?s go|start (the )?plan)\b/.test(t)) {
    const active = await plans.active() || (await plans.list()).find((p) => p.status !== 'done');
    if (!active) { say('There is no plan yet. Say: plan a night out near me.', my); return true; }
    if (active.status !== 'active') { active.status = 'active'; await plans.save(active); }
    return guide(active, my);
  }
  // M) maps: "directions to X", "show bars on the map", "open maps"
  const dir = text.match(/\b(?:directions|route|walk|way)\s+to\s+(.+?)[?.!]*$/i);
  if (dir) {
    await places.load();
    const name = dir[1].trim();
    const hit = (await places.search({ query: name, near: (await Navigator.here()) || { lng: 13.405, lat: 52.52 }, radiusM: 15000, limit: 1 }).catch(() => []))[0];
    const geo = hit || await places.geocode(name, { online: getOnline() });
    if (!geo) { say(`I couldn't find ${name}.`, my); return true; }
    const target = hit || { id: 'geo-' + name, name: geo.label || name, cat: 'sight', lng: geo.lng, lat: geo.lat, tags: {} };
    await openMaps();
    await mapsUI.directionsTo(target);
    say(`Here's the walking route to ${target.name}. Tap Start to go.`, my);
    return true;
  }
  if (/\b(open (the )?maps?|show (me )?(the )?map)\b/.test(t) || (/\bon the map\b/.test(t) && CAT_WORDS.some(([re]) => re.test(t)))) {
    const c = CAT_WORDS.find(([re]) => re.test(t))?.[1];
    await openMaps({ query: c ? (CATEGORIES.find((x) => x.key === c)?.label || c) : (areaOf(text) || '') });
    say(c ? `Here are ${CATEGORIES.find((x) => x.key === c)?.label?.toLowerCase() || c} on the map.` : 'Here is the map.', my);
    return true;
  }
  // 4) find places
  const cat = CAT_WORDS.find(([re]) => re.test(t))?.[1];
  if (cat && /\b(find|show|where|any|recommend|suggest|good|best|nearby|near me|around)\b/.test(t)) {
    setState('thinking');
    await places.load();
    const area = areaOf(text);
    const near = (area && await places.geocode(area, { online: getOnline() })) || await Navigator.here() || { lng: 13.4050, lat: 52.5200, label: 'Mitte' };
    const found = await places.search({ cats: [cat], near, radiusM: 1200, limit: 5, online: getOnline() }).catch(() => []);
    if (my !== turn) return true;
    const label = CATEGORIES.find((c) => c.key === cat)?.label?.toLowerCase() || cat;
    if (!found.length) { say(`I couldn't find ${label} near ${near.label || 'you'}.`, my); return true; }
    const dist = (p) => Math.round(Math.hypot((p.lng - near.lng) * 67800, (p.lat - near.lat) * 111200) / 50) * 50;
    say(`${found.length} ${label} near ${near.label || 'you'}: ` + found.slice(0, 3).map((p) => `${p.name}, about ${dist(p)} metres`).join('; ') + '. Want me to plan a route?', my);
    return true;
  }
  return false;
}
// Spoken turn-by-turn guidance from the user's live location to the current stop.
let nav = null;
function stopGuide() { nav?.stop(); nav = null; }
async function guide(plan, my) {
  stopGuide();
  const stop = plan.stops[plan.current];
  if (!stop) { say('Your plan is finished.', my); return true; }
  setState('thinking');
  const here = await Navigator.here();
  const from = here || (plan.current ? plan.stops[plan.current - 1].place : plan.start);
  const leg = await route([from, stop.place], { online: getOnline() });
  if (my !== turn) return true;
  openPlans('active').then(() => planUI?.showPlan(plan)).catch(() => {});
  const mins = Math.max(1, Math.round(leg.durationS / 60));
  say(`Heading to ${stop.place.name}, ${Math.round(leg.distanceM / 50) * 50} metres, about ${mins} minutes on foot. ${leg.steps[0]?.text || ''}`, my);
  let last = 0;
  nav = new Navigator({
    onUpdate: ({ lng, lat, stepIndex, step, remainingM, arrived }) => {
      try { berlin?.showUser(lng, lat); } catch {}
      if (arrived) { stopGuide(); voice.say(`You've arrived at ${stop.place.name}. Say "I'm here" when you want the next stop.`); return; }
      if (stepIndex !== last && step) { last = stepIndex; caption('tr', `${step.text} · ${Math.round(remainingM)} m left`); voice.say(step.text); }
    },
  });
  nav.start(leg);
  return true;
}

function say(text, my) {
  caption('agent', text); logLine('AI', text);
  setState('speaking'); voice.say(text);
  voice.drain().then(() => { if (my === turn) setState('listening'); });
}

// ---------- aware mode: proactive seeing + hearing ----------
const canSpeak = () => state === 'listening' && micOn && Date.now() - lastSpeechAt > 4000;
function startAware() {
  if (eyes?.captionerReady) {
    aware = new Aware({
      eyes, canSpeak,
      onRemark: ({ text, scene }) => { graph.add('saw', scene).catch(() => {}); say(text, ++turn); },
    });
    aware.start();
  }
  // sounds: every 6 s, note strong non-speech sounds; mention a new one at most every 45 s
  let lastSound = '', lastSoundSay = 0;
  setInterval(() => {
    if (!sounds?.clf || state !== 'listening' || Date.now() - lastSpeechAt < 4000) return;
    const top = sounds.classify(sounds.snapshot(3)).filter((x) => x.score > 0.5)[0];
    if (!top || top.name === lastSound) return;
    lastSound = top.name;
    graph.add('heard', top.name.toLowerCase()).catch(() => {});
    if (canSpeak() && Date.now() - lastSoundSay > 45000) { lastSoundSay = Date.now(); say(`I can hear ${top.name.toLowerCase()}.`, ++turn); }
  }, 6000);
}

// ---------- optional continuous video + audio recording into memory ----------
function startRecording() {
  try {
    // Phones: audio continuously + a still frame every 20 s only when the scene changed (sampled, not video).
    const sampled = profile.mobile;
    const vids = sampled ? [] : (eyes?.stream?.getVideoTracks() || []);
    const tracks = [...vids, ...micStream.getAudioTracks()];
    const mime = (vids.length ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return;
    const id = 'rec-' + Date.now();
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: 250000, audioBitsPerSecond: 24000 });
    recorder.ondataavailable = (e) => { if (e.data?.size) memory.addChunk(id, e.data, mime).catch(() => {}); };
    recorder.start(5000);
    if (sampled) startFrameSampler();
    $('recPill').classList.remove('hidden');
  } catch {}
}
let sampler = null, samplePrev = null;
function startFrameSampler() {
  clearInterval(sampler);
  const c = Object.assign(document.createElement('canvas'), { width: 32, height: 24 }), g = c.getContext('2d', { willReadFrequently: true });
  sampler = setInterval(() => {
    const v = eyes?.video;
    if (!eyes?.enabled || !v?.videoWidth || document.hidden) return;
    g.drawImage(v, 0, 0, 32, 24);
    const px = g.getImageData(0, 0, 32, 24).data, grey = new Uint8Array(32 * 24);
    let d = 0;
    for (let i = 0; i < grey.length; i++) { grey[i] = (px[i * 4] + px[i * 4 + 1] * 2 + px[i * 4 + 2]) >> 2; if (samplePrev) d += Math.abs(grey[i] - samplePrev[i]); }
    const changed = !samplePrev || d / grey.length > 12;
    samplePrev = grey;
    if (changed) memory.addTurn('Cam', 'camera sample', { image: eyes.snapshot(320) }).catch(() => {});
  }, 20000);
}
function restartRecording() { if (recorder) { try { recorder.stop(); } catch {} recorder = null; startRecording(); } }

// Camera sleeps while the app is in the background (battery, heat); comes back as it was.
let camWasOn = false;
document.addEventListener('visibilitychange', () => {
  if (!eyes?.stream) return;
  if (document.hidden) { camWasOn = eyes.enabled; if (camWasOn) eyes.setEnabled(false); }
  else if (camWasOn) eyes.setEnabled(true);
});

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


// A load step with a stall watchdog: if its progress doesn't move for STALL_MS it fails (or is skipped if optional)
// instead of hanging the app forever. Progress is mirrored to the call screen's status pill once the call is open.
const STALL_MS = 90000;
function bgPill(text) { const p = $('bgPill'); if (!p) return; p.textContent = text; p.classList.toggle('hidden', !text); }
function guard(prog, label, run, optional = false) {
  return () => new Promise((resolve, reject) => {
    const row = progressRow(prog, label);
    let last = Date.now(), done = false;
    const tick = (f, text) => { last = Date.now(); row(f, text); if (!$('call').classList.contains('hidden')) bgPill(f >= 1 ? '' : `${label.split(' ·')[0]} ${Math.round((f || 0) * 100)}%`); };
    const dog = setInterval(() => {
      if (done || Date.now() - last < STALL_MS) return;
      done = true; clearInterval(dog);
      row(1, optional ? 'skipped (stalled)' : 'stalled');
      optional ? resolve() : reject(new Error(`${label} stopped loading (no progress for ${STALL_MS / 1000}s). Check the connection and tap Start again; it resumes from the cache.`));
    }, 3000);
    Promise.resolve().then(() => run(tick)).then(() => { if (!done) { done = true; clearInterval(dog); row(1, 'ready'); resolve(); } },
      (e) => { if (done) return; done = true; clearInterval(dog); console.warn(label, e); row(1, optional ? 'skipped' : 'failed');
        optional ? resolve() : reject(e); });
  });
}

// ---------- start ----------
async function start() {
  $('start').disabled = true; $('err').classList.add('hidden');
  mode = $('mode').value; bargeIn = $('bargeIn').checked;
  const useCam = $('useCam').checked;
  ['brain', 'voice', 'mode'].forEach((k) => store.set(k, $(k).value));
  store.set('useCam', useCam); store.set('bargeIn', bargeIn);
  webOn = $('useWeb').checked; store.set('useWeb', webOn);

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
    eyes.lite = profile.mobile;
    if (useCam) await eyes.open('user').catch(() => {});
    $('call').classList.toggle('nocam', !useCam || !eyes.enabled);

    ears = new Ears({ onSpeechStart, onUtterance });
    // Must-have before the call opens: ears (+ brain or translator). Everything else loads after, in the background.
    const now = [guard(prog, 'Ears · Whisper + Silero VAD', (row) => ears.load(micStream, profile, row))];
    const later = [guard(prog, 'Voice · Kokoro-82M (device voice until ready)', (row) => voice.load($('voice').value, profile, row), true)];
    if (mode === 'chat') {
      if (!profile.webgpu) throw new Error('This browser has no WebGPU, which the AI brain needs. Try Chrome or Edge (Android/desktop) or Safari 26+ (iPhone). Translator mode works without it.');
      brain = new Brain($('brain').value, profile);
      brain.history = memory.recentHistory();
      now.unshift(guard(prog, 'Brain · ' + BRAINS.find((b) => b.key === $('brain').value)?.label, (row) => brain.load(row)));
      if (useCam && (!brain.vision || $('useAware').checked))
        later.push(guard(prog, 'Eyes · SmolVLM-256M', (row) => eyes.loadCaptioner(profile, row).then(() => { eyes.captionerReady = true; }), true));
      sounds = new Sounds();
      later.push(guard(prog, 'Hearing · YAMNet sound recognizer', (row) => sounds.load(audioCtx, micStream, row).catch((e) => { sounds = null; throw e; }), true));
    } else {
      translator = new Translator();
      if (mode === 'te-en') profile.asrModel = 'onnx-community/whisper-small'; // tiny/base are too weak for Telugu
      if (mode === 'de-en') {
        now.push(guard(prog, 'Translator · Opus-MT de→en', (row) => translator.load(row)));
        ocr = new GermanOCR();
        later.push(guard(prog, 'Sign reader · Tesseract German', (row) => ocr.load(row).catch((e) => { ocr = null; throw e; }), true));
      }
      if (mode === 'en-te') now.push(guard(prog, 'Translator · NLLB-200 en→te', (row) => translator.loadTelugu(row)));
    }
    // Phones: one model at a time to keep memory peaks low. Desktop: in parallel.
    if (profile.mobile) { for (const j of now) await j(); } else await Promise.all(now.map((j) => j()));

    await enterCall();
    // Background: one at a time so the call stays smooth; progress shows in the call's status pill.
    (async () => {
      for (const j of later) await j().catch(() => {});
      bgPill('');
    })();
  } catch (e) {
    console.error(e);
    $('err').textContent = (e && e.message) || String(e);
    $('err').classList.remove('hidden');
    $('start').disabled = false;
  }
}

async function enterCall() {
  $('setup').classList.add('hidden'); $('call').classList.remove('hidden');
  $('modelPill').textContent = mode === 'chat' ? BRAINS.find((b) => b.key === $('brain').value)?.label.split(' ·')[0]
    : { 'de-en': 'Deutsch → English', 'te-en': 'తెలుగు → English', 'en-te': 'English → తెలుగు' }[mode];
  if (mode === 'en-te' && !voice.hasVoice('te-IN')) caption('tr', 'No Telugu voice on this device: translations are shown as text.');
  $('typeIn').placeholder = { 'de-en': 'Deutsch eingeben…', 'te-en': 'తెలుగులో టైప్ చేయండి…' }[mode] || 'Type a message…';
  $('seeBtn').classList.toggle('hidden', mode !== 'de-en');
  store.set('useAware', $('useAware').checked); store.set('useRec', $('useRec').checked);
  if (mode === 'chat' && $('useAware').checked) startAware();
  if ($('useRec').checked) startRecording();
  $('webBtn').classList.toggle('on', webOn); $('webBtn').classList.toggle('off', !webOn);
  researchOn = mode === 'chat' && store.get('research', false);
  $('researchBtn').classList.toggle('hidden', mode !== 'chat');
  $('researchBtn').classList.toggle('on', researchOn); $('researchBtn').classList.toggle('off', !researchOn);
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
// German text in the camera (signs, menus) → English
$('seeBtn').onclick = async () => {
  const frame = eyes?.snapshot(1280);
  if (!frame || !ocr) return caption('tr', 'Turn the camera on to translate what you see.');
  const my = ++turn; voice.stop();
  setState('looking');
  const de = await ocr.read(frame).catch(() => '');
  if (my !== turn) return;
  if (!de) { caption('tr', 'No German text found — hold the text closer and steady.'); return setState('listening'); }
  caption('you', de); logLine('Deutsch (camera)', de);
  setState('transcribing');
  const en = await translator.deToEn(de).catch(() => '');
  if (my === turn && en) return speakTranslation(en, my);
  setState('listening');
};
$('flipBtn').onclick = () => eyes?.flip().then(restartRecording).catch(() => {});
$('planBtn').onclick = () => openPlans('active').catch((e) => caption('agent', 'Planner unavailable: ' + e.message));
$('openPlan').onclick = () => openPlans('new').catch((e) => { $('err').textContent = 'Planner unavailable: ' + e.message; $('err').classList.remove('hidden'); });
$('researchBtn').onclick = () => { researchOn = !researchOn; store.set('research', researchOn); $('researchBtn').classList.toggle('on', researchOn); $('researchBtn').classList.toggle('off', !researchOn);
  caption('tr', researchOn ? 'Research mode on: I search, read the sources and answer with citations.' : 'Research mode off'); };
$('webBtn').onclick = () => { webOn = !webOn; store.set('useWeb', webOn); $('webBtn').classList.toggle('on', webOn); $('webBtn').classList.toggle('off', !webOn); caption('tr', webOn ? 'Web access on' : 'Offline only'); };
$('logBtn').onclick = () => {
  const log = $('log'); log.innerHTML = '';
  const top = document.createElement('p');
  top.innerHTML = `<b>Memory:</b> ${memory.facts.length} facts · ${memory.turns.length} messages, stored on this device. Say "forget everything" to clear.`;
  log.append(top);
  const tl = document.createElement('p');
  tl.innerHTML = '<b>Timeline (said · saw · heard):</b>';
  log.append(tl);
  for (const e of graph.timeline(40)) {
    const q = document.createElement('p'); q.style.fontSize = '13px';
    q.innerHTML = `<b>${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${e.kind}</b> `;
    q.append(e.text.slice(0, 160)); log.append(q);
  }
  memory.recordings().then((recs) => {
    if (!recs.length) return;
    const h = document.createElement('p'); h.innerHTML = '<b>Recordings:</b>'; log.prepend(h);
    for (const r of recs.slice(0, 10)) {
      const b = document.createElement('button'); b.className = 'ghost';
      b.textContent = `▶ ${new Date(r.start).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${(r.bytes / 1e6).toFixed(1)} MB`;
      b.onclick = async () => { const blob = await memory.recording(r.id); if (!blob) return; const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.style.width = '100%'; v.src = URL.createObjectURL(blob); b.replaceWith(v); v.play().catch(() => {}); };
      h.after(b);
    }
  }).catch(() => {});
  for (const t of memory.turns.slice(-60)) {
    const p = document.createElement('p');
    p.innerHTML = `<b>${new Date(t.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · ${t.who}:</b> `;
    p.append(t.text);
    if (t.image) { const im = new Image(); im.src = t.image; im.style.cssText = 'display:block;max-width:160px;border-radius:8px;margin-top:4px'; p.append(im); }
    if (t.clip) {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '▶ voice'; b.style.marginLeft = '6px';
      b.onclick = async () => { const blob = await memory.clip(t.clip); if (blob) new Audio(URL.createObjectURL(blob)).play(); };
      p.append(b);
    }
    log.append(p);
  }
  $('logSheet').classList.remove('hidden');
  log.scrollTop = log.scrollHeight;
};
$('endBtn').onclick = async () => {
  clearInterval(sampler);
  if (recorder?.state === 'recording') { await new Promise((r) => { recorder.onstop = r; recorder.stop(); setTimeout(r, 1500); }); await memory.recQ; }
  location.reload();
};
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
// ---------- Google-Maps-like screen (offline search, directions, plans) ----------
let mapsUI, mapsFit;
async function openMaps(opts = {}) {
  $('mapsMap').classList.remove('hidden');
  setTimeout(() => mapsFit?.(), 50);
  if (!mapsUI) {
    const [{ MapsUI }, { BerlinMap }, planner] = await Promise.all([import('./maps-ui.js'), import('./map.js'), import('./planner.js')]);
    const m = new BerlinMap($('mapsMap'));
    await m.ensureOffline(() => {});
    await m.show();
    const fit = () => m.map?.resize();
    setTimeout(fit, 50); setTimeout(fit, 600); addEventListener('resize', fit);
    mapsFit = fit;
    await places.load();
    // keep the map layer visible exactly while the Maps overlay is open
    new MutationObserver(() => $('mapsMap').classList.toggle('hidden', $('maps').classList.contains('hidden')))
      .observe($('maps'), { attributes: true, attributeFilter: ['class'] });
    mapsUI = new MapsUI($('maps'), {
      map: m, places, route, Navigator, plans, planner,
      openPlans: (v) => openPlans(v), getOnline, speak: (t) => voice?.say(t),
      onMic: () => { $('maps').classList.add('hidden'); },
    });
    try { (await import('./offline-router.js')).ensureGraph(() => {}).catch(() => {}); } catch {}
  }
  await mapsUI.open(opts);
}
$('mapBtn').onclick = () => openMaps().catch((e) => caption('agent', 'Maps unavailable: ' + e.message));
$('openMap').onclick = () => openMaps().catch((e) => { $('err').textContent = 'Maps unavailable: ' + e.message; $('err').classList.remove('hidden'); });
