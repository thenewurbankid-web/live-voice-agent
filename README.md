# Live — on-device voice & video AI

A live voice + camera AI agent (in the style of ChatGPT voice / Gemini Live) that runs **entirely in your browser**. No server and no API keys. After the first load it works **offline**. Mobile first, and installable as a PWA.

**Open it:** https://thenewurbankid-web.github.io/live-voice-agent/

## What it does
- **Talk hands-free.** Voice activity detection notices when you start and stop speaking. Talk over the AI to interrupt it.
- **Show it things.** It looks at your camera. On desktop the brain (Phi-3.5-vision) sees the frame directly. On phones a tiny captioner (SmolVLM-256M) describes the frame for the brain.
- **German → English translator.** Speak German and hear English, or type German. Works offline.
- **Offline Berlin map.** A vector map of all of Berlin (zoom 15), stored on the device.
- **Installable PWA.** On Android: Install app. On iPhone: Share → Add to Home Screen.

## Built only from open-source blocks
| Block | Library | Model |
|---|---|---|
| Brain | [WebLLM](https://github.com/mlc-ai/web-llm) 0.2.87 | Llama-3.2-1B (phone default), Qwen3-1.7B, Qwen2.5-0.5B, Phi-3.5-vision (desktop default) |
| Ears | [vad-web](https://github.com/ricky0123/vad) 0.0.31 + [transformers.js](https://github.com/huggingface/transformers.js) 3.5.1 | Silero VAD v5, Whisper tiny (phone) / base (desktop) |
| Voice | [kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1 | Kokoro-82M (or the device's built-in voice) |
| Eyes | transformers.js | SmolVLM-256M-Instruct |
| Translator | transformers.js | Whisper `translate` task (speech), Opus-MT de→en (text) |
| Map | [MapLibre GL](https://maplibre.org) 5.7.2 + [PMTiles](https://protomaps.com) 4.5.0 | Protomaps / OpenStreetMap Berlin extract |

Module interfaces are in [CONTRACTS.md](CONTRACTS.md). `js/app.js` only wires the blocks together.

## Requirements
- A browser with WebGPU for the assistant: Chrome or Edge (desktop and Android), or Safari 26+ (iPhone/Mac). Translator mode also works without WebGPU.
- The first start downloads the models once: about 1–1.5 GB on a phone, 3 GB or more with the desktop vision model. Use Wi-Fi.

## Run locally
```bash
python3 -m http.server 8000
```
Then open http://localhost:8000. The camera and microphone need localhost or HTTPS.

Map data © OpenStreetMap contributors, via Protomaps.
