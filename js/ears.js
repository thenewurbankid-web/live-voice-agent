// Ears: Silero VAD (global `vad`) + Whisper (transformers.js, in the shared ML worker) composed together.
import { getMlWorker, progress } from './ml.js';
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

// Whisper's stock outputs on silence / noise, compared against the lowercased transcript with punctuation stripped.
const HALLUCINATIONS = new Set(['thank you for watching', 'thanks for watching', 'thank you', 'thanks', 'please subscribe', 'subscribe',
  'like and subscribe', 'see you next time', 'bye bye', 'bye', 'you', 'the end', 'so', 'okay']);
const MIN_SAMPLES = 8000; // 0.5 s at 16 kHz (VAD output rate)

export class Ears {
  constructor({ onSpeechStart, onUtterance }) {
    this.onSpeechStart = onSpeechStart;
    this.onUtterance = onUtterance;
    this.vad = null;
    this.asr = null;
  }

  async load(micStream, profile, onProgress = () => {}) {
    this.worker = getMlWorker();

    const useGpu = !profile.mobile && profile.webgpu;
    const model = profile.asrModel || (useGpu ? 'onnx-community/whisper-base' : 'onnx-community/whisper-tiny');
    const opts = useGpu
      ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
      : { device: 'wasm', dtype: 'q8' };

    // The worker aggregates per-file progress into one throttled fraction.
    await this.worker.loadAsr(model, opts, progress(onProgress));
    this.asr = true;

    // Silero VAD runs on onnxruntime-web on this thread: one WASM thread so it never fights the UI for cores.
    if (globalThis.ort?.env?.wasm) globalThis.ort.env.wasm.numThreads = 1;

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
    if (!this.asr || !audio || audio.length < MIN_SAMPLES) return '';
    const raw = await this.worker.transcribe(audio, { language, task });
    const text = raw.trim();
    if (text.length < 2) return '';
    if (/^[\[(].*[\])]$/.test(text)) return ''; // [BLANK_AUDIO], (music), ...
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (norm.length < 2 || HALLUCINATIONS.has(norm)) return '';
    return text;
  }
}
