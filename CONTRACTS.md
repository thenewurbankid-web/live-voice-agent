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

---
# Phase 2 — Berlin day / night-out planner (fixed contracts)

Offline-first with a **web switch** (`online: boolean`, set by the user; also forced false when
`!navigator.onLine`). Every online path must fall back to its offline path on any error.
Shared types:
```js
// Place  = { id, name, cat, lng, lat, tags: { opening_hours?, website?, cuisine?, addr? } }
//          cat ∈ 'bar','pub','club','biergarten','cafe','restaurant','sight','museum','park'
// Route  = { line: GeoJSON LineString, distanceM, durationS, steps: [{ text, distanceM, lng, lat }], online: boolean }
// Stop   = { place: Place, arrive: ISO, leave: ISO, done: boolean }
// Plan   = { id, title, kind: 'day'|'night', created: ISO, start: {lng,lat,label}, stops: Stop[],
//            legs: Route[] /* legs[i] = start-or-stop[i-1] → stop[i] */, status: 'draft'|'active'|'done', current: number }
```

## js/places.js + data/berlin-pois.json (offline OSM POIs)
```js
export const CATEGORIES   // [{ key:'bar', label:'Bars', night:true, day:false, minutes:60 }, ...] for every cat above
export class Places {
  async load()                       // fetch data/berlin-pois.json once (cached by sw.js like the shell)
  async search({ cats, near /*{lng,lat}*/, radiusM = 1500, query = '', limit = 20, online = false }) // → Place[] sorted by distance
  async geocode(text, { online })    // → { lng, lat, label } | null ; offline: match a POI/sight name or a built-in list of Berlin neighbourhoods/stations; online: Nominatim (bounded to Berlin, 1 req/s)
}
```
`data/berlin-pois.json`: generated once from Overpass by `tools/build-pois.sh`, compact array form
`[[id,name,cat,lng,lat,opening_hours|null],...]`, named places only, < 5 MB. Online search: Overpass API, around:radius.

## js/routing.js + js/navigator.js
```js
export async function route(points /*[{lng,lat}...] ≥2*/, { online })  // → Route ; online: https://routing.openstreetmap.de/routed-foot/route/v1/foot/…?overview=full&geometries=geojson&steps=true ; offline: straight segments, distance ×1.3 detour factor, 4.8 km/h, steps "Walk 350 m north-east to <name>"
export class Navigator {                                                  // live turn-by-turn on a Route
  constructor({ onUpdate /*({ lng, lat, stepIndex, step, remainingM, arrived })=>void*/ })
  start(route); stop()                                                    // navigator.geolocation.watchPosition, high accuracy; arrived when < 30 m from the end
  static async here()                                                     // → {lng,lat} | null (getCurrentPosition, 8 s timeout)
}
```

## js/planner.js + js/plans-store.js (deterministic planning, no LLM)
```js
export async function buildPlan({ kind, start /*{lng,lat,label}*/, startTime /*Date*/, stops = 4, cats /*optional override*/, vibe = '' }, { places, route, online }) // → Plan
//  day default cats: cafe → sight/museum → restaurant → park/biergarten ; night: restaurant → bar → pub/bar → club
//  greedy nearest next stop within 1500 m (widen to 3000 m if none), prefer places whose opening_hours (opening_hours.js lib, OSS) say open at arrival, never repeat a place
//  stay = CATEGORIES[cat].minutes; legs via route(); title like "Night out · Kreuzberg"
export function replaceStop(plan, index, place, deps) ; export function removeStop(plan, index, deps) ; export function moveStop(plan, from, to, deps) // → Promise<Plan> recomputing times + legs
export class PlansStore {   // IndexedDB via idb-keyval (OSS, CDN), key 'plans'
  async list()             // → Plan[] newest first
  async get(id); async save(plan); async remove(id)
  async active()           // → Plan | null (status 'active')
}
```

## js/web.js (agent web access, key-free CORS APIs only)
```js
export async function webSearch(query, { limit = 5 } = {}) // → [{ title, snippet, url, source }] ; Wikipedia (en + de) search API with origin=*, plus DuckDuckGo Instant Answer if CORS allows
export async function readPage(url)                         // → plain text summary (Wikipedia REST /page/summary for wiki URLs; otherwise '')
export function needsWeb(text)                              // → boolean: heuristics like "search", "look up", "latest", "news", "who is", "what is"
```

## js/plan-ui.js (Plan sheet; extends the map)
```js
export class PlanUI {
  constructor(rootEl, { places, store, map /*BerlinMap*/, buildPlan, replaceStop, removeStop, moveStop, route, Navigator, getOnline /*()=>boolean*/, speak /*(text)=>void*/ })
  async open(view = 'active' /*'new'|'active'|'history'*/) ; close()
  async showPlan(plan)     // timeline of stops (time, name, category, walk minutes), progress bar = done/total + ETA to end, Start/Next/Done buttons, Navigate button per leg, swap/remove/reorder per stop
  async createFromVoice({ kind, startText, stops })  // used by app.js intents
}
```
Also adds to js/map.js (owned by the plan-ui agent): `drawPlan(plan)` (route lines + numbered markers), `showUser(lng,lat)`, `clearPlan()`.
Views: **New** (Day/Night toggle, start = "My location" or typed place, start time, # stops, Build), **Active** (map + timeline + progress), **History** (previous plans: open, duplicate, delete). Mobile-first bottom sheet, same CSS tokens as index.html (`--panel`, `--line`, `--accent`, …), styles injected by the module.

## app.js wiring (main session)
Web toggle on setup + call screen; intents: "plan a night out / day in <area>" → PlanUI.createFromVoice; "navigate / next stop" → Navigator; "find bars near …" → Places.search, spoken summary; needsWeb(text) → webSearch results passed to the brain as context. Brain only narrates results; it never invents places.

## js/ocr.js (German text in the camera → English)
```js
export class GermanOCR {
  async load(onProgress)          // Tesseract.js (OSS, CDN-pinned) worker with 'deu' language data; worker/core/lang paths all on cdn.jsdelivr.net so sw.js caches them for offline
  async read(dataUrl)             // → recognized German text, cleaned (joined lines, dropped 1–2 char noise, confidence > 60 words only)
}
```
app.js: translator mode gets a "Translate what I see" button: eyes.snapshot(1280) → ocr.read → translator.deToEn → caption + voice.say.

---
# Phase 3 — Google-Maps-like screen + true offline walking routes

## data/berlin-walk.bin + js/offline-router.js + js/router-worker.js (offline A* on the OSM walking network)
Build once with `tools/build-walk-graph.sh` (Geofabrik `berlin-latest.osm.pbf` + pyosmium or osmium-tool; walkable
`highway=*` minus motorway/trunk/construction/`foot=no`/`access=private`). Simplify to intersections (keep nodes of degree ≠ 2
and named-street changes), edges keep length (m), street name id and a simplified polyline (Douglas–Peucker ~3 m).
Binary file (little-endian), documented in the script header, total < 40 MB; GitHub Pages gzips it.
```js
// js/offline-router.js (main thread; spins up js/router-worker.js which loads the graph + ngraph.graph/ngraph.path from jsdelivr, pinned)
export async function ensureGraph(onProgress)   // download data/berlin-walk.bin once, keep the ArrayBuffer in Cache API 'berlin-walk-v1' (offline afterwards)
export async function routeOffline(points /*[{lng,lat}...]*/) // → Route (same shape as js/routing.js, online:false) or null if outside the graph
//   snap each point to the nearest graph node (grid index), A* (ngraph.path.aStar, haversine heuristic), stitch polylines,
//   steps from bearing changes > 30° and street-name changes: "Turn left onto Oranienstraße, then 200 m", 4.8 km/h
```
`js/routing.js` change (router agent owns it): offline branch (and online-error fallback) calls `routeOffline` first and
only falls back to straight lines if it returns null / the graph is not available.

## js/maps-ui.js (Google-Maps-like full-screen screen; extends js/map.js and js/planner.js)
```js
export class MapsUI {
  constructor(rootEl, { map /*BerlinMap*/, places, route, Navigator, plans /*PlansStore*/, planner /*{ buildPlan, replaceStop, removeStop, moveStop, addStop }*/, openPlans /*(view)=>void*/, getOnline, speak })
  async open({ query = '', place = null } = {}) ; close()
  async search(query)            // categories by keyword (bars, cafés, food, sights, museums, parks, clubs, biergarten) or name / area via places.geocode
  async showPlace(place)         // place card
  async directionsTo(place, { from = null } = {}) // from = my location (Navigator.here) or a typed place; route(); draws line; step list; Start → follow-me nav
  async addToPlan(place)         // into the active plan (or a new draft plan) via planner.addStop, saves via plans.save
}
```
Layout (mobile first, all inside rootEl, which is a full-screen fixed element): map fills the screen; top: rounded search
bar (back/menu, input, mic icon that calls `speak`-less hook `onMic` if provided) + horizontally scrolling category chips;
bottom: draggable sheet with three snap points (peek 120 px / half / full) showing results list → place card → directions.
Place card: name, category, open now / closed (opening_hours.js, pinned), distance + walk minutes from me, buttons
**Directions**, **Add to plan**, **Website** (if tag). Directions: from/to rows, total min + km, offline/online badge, step
list, **Start**. Navigation: big current-instruction banner on top, remaining min/m, recenter button, map follows the user
(`map.follow(true)`), speak(step.text) on each new step, arrival → "You've arrived. Next plan stop?" when the place is in the active plan.
Right-side floating buttons: my location, layers toggle "Plan" (draw active plan with numbered stops via map.drawPlan).
Add to js/map.js: `setResults(places, onClick)`, `drawRoute(route)`, `clearRoute()`, `follow(on)`, `onLongPress(cb)` (long-press map → "Directions to here"), keep existing methods.
Add to js/planner.js: `addStop(plan, place, index = plan.stops.length, deps)` → Promise<Plan> recomputing times + legs (like the others).
Styles injected by the module, using index.html CSS variables; Google-Maps-like but our own look (no Google branding).
