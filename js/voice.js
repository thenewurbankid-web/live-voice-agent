// Kokoro-82M TTS (kokoro-js) with browser speechSynthesis fallback. Pure composition.
import { createMlWorker, progress } from './ml.js';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const VOICES = [
  { key: 'af_heart', label: 'Heart (US F)' },
  { key: 'af_bella', label: 'Bella (US F)' },
  { key: 'am_michael', label: 'Michael (US M)' },
  { key: 'am_fenrir', label: 'Fenrir (US M)' },
  { key: 'bf_emma', label: 'Emma (UK F)' },
  { key: 'bm_george', label: 'George (UK M)' },
  { key: 'browser', label: 'Device voice (fastest)' },
];

function clean(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>~|]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Voice {
  constructor(audioContext) {
    this.ctx = audioContext;
    this._analyser = audioContext.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.connect(audioContext.destination);
    this.tts = null;
    this.voiceKey = 'browser';
    this.gen = 0;
    this.synthChain = Promise.resolve(); // serializes Kokoro generate calls
    this.playChain = Promise.resolve();  // plays items in order
    this.pending = 0;
    this.idleWaiters = [];
    this.source = null;
  }

  get analyser() { return this._analyser; }

  async load(voiceKey, profile, onProgress = () => {}) {
    this.voiceKey = voiceKey;
    if (voiceKey === 'browser') { onProgress(1, 'Device voice ready'); return; }
    // Kokoro keeps its own ml-worker instance (not the shared one) so speech is synthesized in parallel
    // with ASR, captioning, translation and embeddings.
    const w = createMlWorker();
    const cb = progress((f) => onProgress(Math.min(1, f), 'Loading voice'));
    const wantGpu = !profile.mobile && profile.webgpu;
    try {
      const opts = wantGpu ? { device: 'webgpu', dtype: 'fp32' } : { device: 'wasm', dtype: 'q8' };
      await w.loadTts(MODEL_ID, opts, cb);
    } catch (e) {
      if (!wantGpu) throw e;
      await w.loadTts(MODEL_ID, { device: 'wasm', dtype: 'q8' }, cb);
    }
    this.tts = { generate: (t, { voice }) => w.speak(t, voice) }; // same shape as KokoroTTS, runs in the worker
    onProgress(1, 'Voice ready');
  }

  say(text, { lang = '' } = {}) {
    const t = clean(text);
    if (!t) return;
    const gen = this.gen;
    this.pending++;
    let item;
    if (lang) {
      item = Promise.resolve({ lang, text: t }); // non-English (e.g. te-IN): device voice for that language
    } else if (this.voiceKey === 'browser' || !this.tts) {
      item = Promise.resolve(t);
    } else {
      // synth starts as soon as the previous synth finishes, overlapping playback of earlier items
      item = this.synthChain = this.synthChain.then(async () => {
        if (gen !== this.gen) return null;
        try { return await this.tts.generate(t, { voice: this.voiceKey }); } catch { return null; }
      });
    }
    this.playChain = this.playChain.then(async () => {
      try {
        const r = await item;
        if (gen !== this.gen || !r) return;
        if (typeof r === 'string') await this._speak(r, gen);
        else if (r.lang) await this._speak(r.text, gen, r.lang);
        else await this._play(r, gen);
      } finally {
        if (--this.pending === 0) this._flush();
      }
    });
  }

  _play(raw, gen) {
    return new Promise((resolve) => {
      const buf = this.ctx.createBuffer(1, raw.audio.length, raw.sampling_rate);
      buf.copyToChannel(raw.audio, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this._analyser);
      this.source = src;
      src.onended = () => { if (this.source === src) this.source = null; resolve(); };
      if (gen !== this.gen) return resolve();
      src.start();
    });
  }

  hasVoice(lang) {
    const p = lang.toLowerCase().split('-')[0];
    return speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith(p));
  }

  _speak(text, gen, lang = '') {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (lang) {
        u.lang = lang;
        const p = lang.toLowerCase().split('-')[0];
        const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(p));
        if (v) u.voice = v;
      }
      u.onend = u.onerror = () => resolve();
      if (gen !== this.gen) return resolve();
      speechSynthesis.speak(u);
    });
  }

  stop() {
    this.gen++;
    try { speechSynthesis.cancel(); } catch {}
    if (this.source) { try { this.source.stop(); } catch {} this.source = null; }
  }

  drain() {
    return this.pending === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  _flush() { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((r) => r()); }

  unlock() {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {}
  }
}
