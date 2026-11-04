// Ambient sound recognition: YAMNet (521 AudioSet classes) via MediaPipe Tasks Audio, on a rolling mic buffer.
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.2';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';
const IGNORE = /^(speech|silence|inside, small room|inside, large room|male speech|female speech|conversation|narration|child speech|whispering|hubbub)/i;

export class Sounds {
  async load(audioCtx, micStream, onProgress = () => {}) {
    onProgress(0.1, 'Loading sound recognizer');
    const { AudioClassifier, FilesetResolver } = await import(`${MP}/+esm`);
    const files = await FilesetResolver.forAudioTasks(`${MP}/wasm`);
    this.clf = await AudioClassifier.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, maxResults: 8, scoreThreshold: 0.08 });
    // Rolling 4 s buffer of the mic at the context's sample rate.
    this.rate = audioCtx.sampleRate;
    this.ring = new Float32Array(this.rate * 4); this.pos = 0;
    const src = audioCtx.createMediaStreamSource(micStream);
    const tap = audioCtx.createScriptProcessor(4096, 1, 1);
    tap.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < x.length; i++) { this.ring[this.pos] = x[i]; this.pos = (this.pos + 1) % this.ring.length; }
    };
    const mute = audioCtx.createGain(); mute.gain.value = 0;
    src.connect(tap); tap.connect(mute); mute.connect(audioCtx.destination);
    onProgress(1, 'Sound recognizer ready');
  }

  // Copy of the last `seconds` of audio (e.g. taken the moment the user starts talking = the sound before it).
  snapshot(seconds = 3) {
    if (!this.ring) return null;
    const n = Math.min(this.ring.length, Math.round(this.rate * seconds)), out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.ring[(this.pos - n + i + this.ring.length) % this.ring.length];
    return out;
  }

  // → [{ name, score }] of non-speech sounds, strongest first.
  classify(samples) {
    if (!this.clf || !samples) return [];
    const res = this.clf.classify(samples, this.rate);
    const best = new Map();
    for (const r of res) for (const c of r.classifications?.[0]?.categories || []) {
      if (IGNORE.test(c.categoryName)) continue;
      best.set(c.categoryName, Math.max(best.get(c.categoryName) || 0, c.score));
    }
    return [...best].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
  }

  async listen(seconds = 3) {
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return this.classify(this.snapshot(seconds));
  }
}

export function describeSounds(list) {
  const top = list.filter((s) => s.score > 0.15).slice(0, 3).map((s) => s.name.toLowerCase());
  if (!top.length) return '';
  return top.length === 1 ? top[0] : top.slice(0, -1).join(', ') + ' and ' + top.at(-1);
}
