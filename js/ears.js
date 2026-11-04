// Ears: Silero VAD (global `vad`) + Whisper (transformers.js) composed together.
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

const HALLUCINATIONS = new Set(['thank you', 'thanks for watching', 'you', 'bye', 'the end']);

export class Ears {
  constructor({ onSpeechStart, onUtterance }) {
    this.onSpeechStart = onSpeechStart;
    this.onUtterance = onUtterance;
    this.vad = null;
    this.asr = null;
  }

  async load(micStream, profile, onProgress = () => {}) {
    const { pipeline } = await import(TRANSFORMERS);

    const useGpu = !profile.mobile && profile.webgpu;
    const model = profile.asrModel || (useGpu ? 'onnx-community/whisper-base' : 'onnx-community/whisper-tiny');
    const opts = useGpu
      ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
      : { device: 'wasm', dtype: 'q8' };

    // Aggregate per-file progress: sum(loaded) / sum(total) across all files.
    const files = {};
    const progress_callback = (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = { loaded: p.loaded, total: p.total };
      let loaded = 0, total = 0;
      for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
      onProgress(total ? loaded / total : 0, 'Loading ears');
    };

    this.asr = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback });

    this.vad = await vad.MicVAD.new({
      model: 'v5',
      startOnLoad: false,
      getStream: async () => micStream,
      pauseStream: async () => {},
      resumeStream: async () => micStream,
      baseAssetPath: VAD_BASE,
      onnxWASMBasePath: ORT_BASE,
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.45,
      redemptionMs: 600,
      minSpeechMs: 300,
      preSpeechPadMs: 300,
      onSpeechRealStart: () => this.onSpeechStart?.(),
      onSpeechEnd: (audio) => this.onUtterance?.(audio),
    });
    onProgress(1, 'Ears ready');
  }

  async start() { await this.vad?.start(); }
  async pause() { await this.vad?.pause(); }

  async transcribe(audio, { language = 'english', task = 'transcribe' } = {}) {
    if (!this.asr) return '';
    const out = await this.asr(audio, { language, task });
    const raw = (Array.isArray(out) ? out[0]?.text : out?.text) || '';
    const text = raw.trim();
    if (text.length < 2) return '';
    if (/^[\[(].*[\])]$/.test(text)) return ''; // [BLANK_AUDIO], (music), ...
    const norm = text.toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (norm.length < 2 || HALLUCINATIONS.has(norm)) return '';
    return text;
  }
}
