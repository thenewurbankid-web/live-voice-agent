// Ambient sound recognition: YAMNet (521 AudioSet classes) via MediaPipe Tasks Audio, on a rolling mic buffer.
// The mic is tapped by an AudioWorklet that downsamples to 16 kHz off the main thread and posts ~128 ms batches;
// YAMNet runs in its own small module worker (inline, Blob URL) so classification never blocks the UI.
import { Comlink } from './ml.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.2';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const COMLINK = 'https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm';
const IGNORE = /^(speech|silence|inside, small room|inside, large room|male speech|female speech|conversation|narration|child speech|whispering|hubbub)/i;
const RATE = 16000;   // YAMNet's native rate
const BATCH = 2048;   // 128 ms at 16 kHz per message

// Box-filter decimator (averages the input samples that fall into each output sample) → 16 kHz batches.
const TAP = `class LvaTap extends AudioWorkletProcessor {
  constructor(o) { super(); const { rate, batch } = o.processorOptions; this.ratio = sampleRate / rate; this.acc = 0; this.n = 0; this.ph = 0; this.len = batch; this.buf = new Float32Array(batch); this.i = 0; }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    for (let k = 0; k < x.length; k++) {
      this.acc += x[k]; this.n++; this.ph += 1;
      if (this.ph >= this.ratio) {
        this.ph -= this.ratio; this.buf[this.i++] = this.acc / this.n; this.acc = 0; this.n = 0;
        if (this.i === this.len) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.len); this.i = 0; }
      }
    }
    return true;
  }
}
registerProcessor('lva-tap', LvaTap);`;

// MediaPipe loads its wasm glue with importScripts(), which module workers forbid: run it as a classic script.
const WORKER = `import * as Comlink from '${COMLINK}';
self.importScripts = (...urls) => { for (const u of urls) { const x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); (0, eval)(x.responseText); } };
let clf;
Comlink.expose({
  async load(mp, model, opts) {
    const { AudioClassifier, FilesetResolver } = await import(mp + '/+esm');
    const files = await FilesetResolver.forAudioTasks(mp + '/wasm');
    clf = await AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: model }, ...opts });
  },
  classify(samples, rate) {
    return clf.classify(samples, rate).map((r) => (r.classifications?.[0]?.categories || []).map((c) => ({ name: c.categoryName, score: c.score })));
  },
});`;

const blobUrl = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
const withTap = new WeakSet();
const CLF_OPTS = { maxResults: 8, scoreThreshold: 0.08 };

export class Sounds {
  async load(audioCtx, micStream, onProgress = () => {}) {
    onProgress(0.1, 'Loading sound recognizer');
    this.rate = Math.min(RATE, audioCtx.sampleRate);
    this.ring = new Float32Array(this.rate * 4); this.pos = 0; // rolling 4 s at 16 kHz
    if (!withTap.has(audioCtx)) { await audioCtx.audioWorklet.addModule(blobUrl(TAP)); withTap.add(audioCtx); }
    this.src = audioCtx.createMediaStreamSource(micStream);
    this.tap = new AudioWorkletNode(audioCtx, 'lva-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { rate: this.rate, batch: BATCH } });
    this.tap.port.onmessage = (e) => this._push(e.data);
    this.mute = audioCtx.createGain(); this.mute.gain.value = 0;
    this.src.connect(this.tap); this.tap.connect(this.mute); this.mute.connect(audioCtx.destination);
    onProgress(0.3, 'Loading sound recognizer');

    try {
      this.worker = new Worker(blobUrl(WORKER), { type: 'module' });
      const remote = Comlink.wrap(this.worker);
      await remote.load(MP, MODEL, CLF_OPTS);
      this.clf = { classify: (s, r) => remote.classify(s, r) };
      this.offThread = true;
    } catch {
      // Fallback: MediaPipe on this thread.
      this.worker?.terminate(); this.worker = null;
      const { AudioClassifier, FilesetResolver } = await import(`${MP}/+esm`);
      const files = await FilesetResolver.forAudioTasks(`${MP}/wasm`);
      const clf = await AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, ...CLF_OPTS });
      this.clf = { classify: (s, r) => clf.classify(s, r).map((x) => (x.classifications?.[0]?.categories || []).map((c) => ({ name: c.categoryName, score: c.score }))) };
      this.offThread = false;
    }
    onProgress(1, 'Sound recognizer ready');
  }

  // Ring write in at most two slices.
  _push(chunk) {
    const r = this.ring, n = chunk.length, L = r.length;
    if (n >= L) { r.set(chunk.subarray(n - L)); this.pos = 0; return; }
    const first = Math.min(n, L - this.pos);
    r.set(chunk.subarray(0, first), this.pos);
    if (first < n) r.set(chunk.subarray(first), 0);
    this.pos = (this.pos + n) % L;
  }

  // Copy of the last `seconds` of audio at 16 kHz (e.g. taken the moment the user starts talking = the sound before it).
  snapshot(seconds = 3) {
    if (!this.ring) return null;
    const r = this.ring, L = r.length, n = Math.min(L, Math.round(this.rate * seconds));
    const start = (this.pos - n + L) % L;
    if (start + n <= L) return r.slice(start, start + n);
    const out = new Float32Array(n), head = L - start;
    out.set(r.subarray(start), 0); out.set(r.subarray(0, n - head), head);
    return out;
  }

  // → Promise<[{ name, score }]> of non-speech sounds, strongest first. samples: Float32Array at this.rate (16 kHz).
  async classify(samples) {
    if (!this.clf || !samples) return [];
    const res = await this.clf.classify(samples, this.rate);
    const best = new Map();
    for (const cats of res) for (const c of cats) {
      if (IGNORE.test(c.name)) continue;
      best.set(c.name, Math.max(best.get(c.name) || 0, c.score));
    }
    return [...best].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
  }

  async listen(seconds = 3) {
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return this.classify(this.snapshot(seconds));
  }

  // Disconnects the mic tap and ends the classifier worker.
  stop() {
    for (const n of [this.src, this.tap, this.mute]) { try { n?.disconnect(); } catch {} }
    if (this.tap) this.tap.port.onmessage = null;
    this.worker?.terminate();
    this.src = this.tap = this.mute = this.worker = null; this.clf = null;
  }
}

export function describeSounds(list) {
  const top = list.filter((s) => s.score > 0.15).slice(0, 3).map((s) => s.name.toLowerCase());
  if (!top.length) return '';
  return top.length === 1 ? top[0] : top.slice(0, -1).join(', ') + ' and ' + top.at(-1);
}
