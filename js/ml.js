// One shared ML Web Worker (ml-worker.js, wrapped with Comlink) for ASR, embeddings + graph memory,
// the SmolVLM captioner and the translators. Kokoro TTS gets its own instance (createMlWorker) so
// speech output is synthesized in parallel with whatever the shared worker is doing.
import * as Comlink from 'https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm';

export { Comlink };

const spawn = () => Comlink.wrap(new Worker(new URL('./ml-worker.js', import.meta.url), { type: 'module' }));
let shared;

export function getMlWorker() { return (shared ||= spawn()); }
export function createMlWorker() { return spawn(); }

// (fraction, label) progress callback that can cross into the worker; the worker throttles calls to ~10/s.
export const progress = (onProgress = () => {}) => Comlink.proxy((f, label) => { try { onProgress(f, label); } catch {} });
