# Module contracts (fixed — do not change signatures)

Static site, no build step, ES modules loaded straight from CDNs. Every module is a
thin composition over an open-source library: no hand-rolled ML, DSP or protocols.
Mobile-first: phones are the default target; desktop gets bigger models.

Pinned CDNs (use exactly these):
- WebLLM:        `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm`
- Transformers:  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm` (same version kokoro-js bundles)
- Kokoro TTS:    `https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm`
- Silero VAD:    global `vad` from `@ricky0123/vad-web@0.0.31/dist/bundle.min.js` (loaded by index.html, with `onnxruntime-web@1.22.0/dist/ort.wasm.min.js` before it)

Shared type: `Progress = (fraction: number /*0..1*/, label: string) => void`.
`profile = { mobile: boolean, webgpu: boolean, f16: boolean }` is built by app.js.

## js/brain.js  (WebLLM, runs in a Web Worker)
```js
export const BRAINS            // [{ key, label, id, idF32, vision:boolean, qwen3:boolean, mobileOk:boolean }]
export function defaultBrainKey(profile) // "llama1b" on mobile, "phi-vision" on desktop
export class Brain {
  constructor(key, profile)
  get vision()                 // true if the LLM takes images directly
  async load(onProgress)       // CreateWebWorkerMLCEngine(new Worker(new URL('./llm-worker.js', import.meta.url), {type:'module'}), id)
  async *reply(text, { image /*dataURL|null*/, scene /*string|null*/ }) // yields text deltas
  interrupt()                  // engine.interruptGenerate()
}
```
BRAINS: `phi-vision` Phi-3.5-vision-instruct (vision, desktop), `qwen3-1.7` Qwen3-1.7B, `llama1b` Llama-3.2-1B-Instruct (mobile default), `qwen0.5` Qwen2.5-0.5B-Instruct. `id` = `…-q4f16_1-MLC`, `idF32` = `…-q4f32_1-MLC` (used when `!profile.f16`).
reply(): system prompt = short spoken replies, 1–3 sentences, no markdown/lists/emoji; if `scene` given, prepend "Camera view: <scene>" to the user text; if `image` and vision, user content = `[{type:'image_url',image_url:{url:image}},{type:'text',text}]`. Keep last 8 history messages as plain text. Qwen3: `extra_body:{enable_thinking:false}` and strip `<think>…</think>` from yields. `stream:true, max_tokens:200, temperature:0.7`. Serialize calls: a new reply() awaits the previous one finishing; on early consumer exit (generator `return`) call interruptGenerate and drain the stream. If the engine rejects the system message, retry once folding it into the user text.
`js/llm-worker.js`: `WebWorkerMLCEngineHandler` boilerplate, 3 lines.

## js/ears.js  (Silero VAD + Whisper via transformers.js)
```js
export class Ears {
  constructor({ onSpeechStart /*()=>void, real speech confirmed*/, onUtterance /*(Float32Array 16kHz)=>void*/ })
  async load(micStream, profile, onProgress) // whisper: mobile → onnx-community/whisper-tiny wasm q8; desktop+webgpu → onnx-community/whisper-base webgpu {encoder_model:'fp32',decoder_model_merged:'q4'}
  async start(); async pause()
  async transcribe(audio) // → cleaned string, '' for noise/hallucinations ("[BLANK_AUDIO]", "(music)", "Thank you.", "you", <2 chars)
}
```
VAD: `vad.MicVAD.new({ model:'v5', startOnLoad:false, getStream: async()=>micStream, pauseStream: async()=>{}, resumeStream: async()=>micStream, baseAssetPath:'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/', onnxWASMBasePath:'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/', positiveSpeechThreshold:0.6, negativeSpeechThreshold:0.45, redemptionMs:600, minSpeechMs:300, preSpeechPadMs:300, onSpeechRealStart, onSpeechEnd })`. Whisper call: `{language:'english', task:'transcribe'}`. Progress aggregates transformers.js `progress_callback` (sum loaded / sum total over files).

## js/voice.js  (Kokoro-82M TTS, browser speechSynthesis fallback)
```js
export const VOICES   // [{ key:'af_heart', label:'Heart (US F)' }, af_bella, am_michael, am_fenrir, bf_emma, bm_george, { key:'browser', label:'Device voice (fastest)' }]
export class Voice {
  constructor(audioContext)
  get analyser()                // AnalyserNode on the output (for the orb)
  async load(voiceKey, profile, onProgress) // KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', desktop+webgpu: {device:'webgpu',dtype:'fp32'}; else {device:'wasm',dtype:'q8'}); fall back to wasm q8 on error; 'browser' loads nothing
  say(text)                     // queue: synth serially, play in order, synth of N+1 overlaps playback of N; strips markdown/emoji/URLs
  stop()                        // cancel everything queued + playing, instantly
  drain()                       // Promise resolving when the queue is empty
  unlock()                      // call inside a user gesture: resume ctx, prime speechSynthesis (iOS)
}
```
Playback via AudioBufferSourceNode → analyser → destination. A generation counter makes stop() drop stale queue items.

## js/eyes.js  (camera + SmolVLM-256M captioner for non-vision brains)
```js
export class Eyes {
  constructor(videoEl)
  async open(facing='user')     // getUserMedia video only, sets videoEl.srcObject; mirrors front cam via class 'mirror'
  async flip(); setEnabled(on); get enabled()
  snapshot(maxSide=448)         // → JPEG dataURL (not mirrored) or null if disabled/not ready
  async loadCaptioner(profile, onProgress) // HuggingFaceTB/SmolVLM-256M-Instruct, AutoProcessor + AutoModelForVision2Seq, dtype {embed_tokens:'fp16',vision_encoder:'q4',decoder_model_merged:'q4'}, webgpu if available else wasm
  async describe(dataUrl)       // → one-sentence scene description, max_new_tokens 48, do_image_splitting:false
}
```

## js/app.js + index.html + PWA (owner: main session)
State machine idle→listening→transcribing→thinking→speaking, turn counter for cancellation,
barge-in on `onSpeechStart`, sentence chunking of the LLM stream into `voice.say`.
PWA: `manifest.webmanifest`, `sw.js` (cache app shell; models are cached by the libraries themselves), `icon.svg`.
