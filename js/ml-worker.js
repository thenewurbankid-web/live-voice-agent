// Off-main-thread inference: Whisper (transformers.js) and Kokoro (kokoro-js), exposed with Comlink.
// One instance per model, so speech-to-text and text-to-speech run in parallel and never block taps or video.
import * as Comlink from 'https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
let asr, tts, emb;

Comlink.expose({
  async loadAsr(model, opts, onProgress) {
    const { pipeline } = await import(TRANSFORMERS);
    asr = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback: (p) => onProgress(p) });
  },
  async transcribe(audio, o) {
    const out = await asr(audio, o);
    return (Array.isArray(out) ? out[0]?.text : out?.text) || '';
  },
  async embed(text) {
    if (!emb) { const { pipeline } = await import(TRANSFORMERS); emb = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', device: 'wasm' }); }
    const t = await emb(text, { pooling: 'mean', normalize: true });
    return Array.from(t.data, (x) => Math.round(x * 1e4) / 1e4);
  },
  async loadTts(id, opts, onProgress) {
    const { KokoroTTS } = await import(KOKORO);
    tts = await KokoroTTS.from_pretrained(id, { ...opts, progress_callback: (p) => onProgress(p) });
  },
  async speak(text, voice) {
    const r = await tts.generate(text, { voice });
    return Comlink.transfer({ audio: r.audio, sampling_rate: r.sampling_rate }, [r.audio.buffer]);
  },
});
