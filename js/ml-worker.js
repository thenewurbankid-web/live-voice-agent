// Off-main-thread inference, exposed with Comlink: Whisper ASR, MiniLM embeddings + the graph-memory vector
// store (IndexedDB via idb-keyval, compromise NLP), SmolVLM captioning, Opus-MT / NLLB translation
// (transformers.js) and Kokoro TTS (kokoro-js). js/ml.js shares one instance for everything except Kokoro.
import * as Comlink from 'https://cdn.jsdelivr.net/npm/comlink@4.4.2/+esm';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const IDB = 'https://cdn.jsdelivr.net/npm/idb-keyval@6.3.0/+esm';
const NLP = 'https://cdn.jsdelivr.net/npm/compromise@14.19.0/+esm';
const VLM = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const VLM_PROMPT = 'Describe what you see in one short sentence.';
const TRANSLATORS = { 'de-en': 'Xenova/opus-mt-de-en', 'en-de': 'Xenova/opus-mt-en-de', nllb: 'Xenova/nllb-200-distilled-600M' };
const MAX_EVENTS = 5000;
const STOP = new Set(['i', 'you', 'me', 'it', 'that', 'this', 'thing', 'things', 'something', 'image', 'picture', 'camera', 'time', 'way', 'lot']);

let tfP, asr, tts, embP, capP, nlpP;
const transP = {};
const tf = () => (tfP ||= import(TRANSFORMERS));

// Per-file download progress → one throttled fraction, so the main thread gets ~10 messages/s, not hundreds.
function tracker(onProgress, label) {
  if (!onProgress) return undefined;
  const files = {};
  let last = 0;
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files[p.file] = [p.loaded, p.total];
    const now = Date.now();
    if (now - last < 100 && p.loaded < p.total) return;
    last = now;
    let l = 0, t = 0;
    for (const [a, b] of Object.values(files)) { l += a; t += b; }
    Promise.resolve(onProgress(t ? l / t : 0, label)).catch(() => {});
  };
}

// One run at a time per model (ORT sessions are not re-entrant); different models still interleave.
const queues = {};
function serial(key, fn) {
  const run = (queues[key] || Promise.resolve()).then(fn, fn);
  queues[key] = run.catch(() => {});
  return run;
}
const once = (p, reset) => p.catch((e) => { reset(); throw e; });
const sentences = (text) => text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [text];

async function embedVec(text) {
  embP ||= once(tf().then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', device: 'wasm' })), () => { embP = null; });
  const emb = await embP;
  const t = await serial('emb', () => emb(text, { pooling: 'mean', normalize: true }));
  return new Float32Array(t.data);
}

async function entities(text) {
  try {
    nlpP ||= import(NLP).then((m) => m.default);
    const doc = (await nlpP)(text);
    const out = [...doc.people().out('array'), ...doc.places().out('array'), ...doc.organizations().out('array'), ...doc.nouns().toSingular().out('array')]
      .map((s) => s.toLowerCase().replace(/^(the|a|an|my|your|some)\s+/, '').replace(/[^\p{L}\p{N} '-]/gu, '').trim())
      .filter((s) => s.length > 2 && s.split(' ').length <= 3 && !STOP.has(s));
    return [...new Set(out)].slice(0, 8);
  } catch { return []; }
}

function translatorFor(key, onProgress, label) {
  const id = TRANSLATORS[key];
  if (!id) throw new Error(`unknown translator ${key}`);
  return (transP[key] ||= once(tf().then(({ pipeline }) =>
    pipeline('translation', id, { dtype: 'q8', device: 'wasm', progress_callback: tracker(onProgress, label) })), () => { delete transP[key]; }));
}

// Graph memory store: one IndexedDB key per event ('e:<id>', vector as Float32Array) plus a small 'meta' record.
let kv, store, memP;
const vecs = new Map();   // id → Float32Array
const evs = new Map();    // id → event without its vector
let order = [];           // ids, oldest first
async function memDb() {
  kv ||= await import(IDB);
  store ||= kv.createStore('lva-graph', 'events');
  return kv;
}
async function memLoad() {
  await (memP ||= once((async () => {
    const db = await memDb();
    if (!(await db.get('meta', store))) {
      // One-time migration of the old single-array 'g:events' (default idb-keyval store, boxed number[] vectors).
      const legacy = await db.get('g:events');
      const keep = Array.isArray(legacy) ? legacy.slice(-MAX_EVENTS) : [];
      if (keep.length) await db.setMany(keep.map((e) => [`e:${e.id}`, { ...e, ents: e.ents || [], vec: e.vec ? Float32Array.from(e.vec) : null }]), store);
      await db.set('meta', { v: 1, migrated: keep.length }, store);
      if (legacy !== undefined) await db.del('g:events');
    }
    const all = (await db.entries(store)).filter(([k]) => typeof k === 'string' && k.startsWith('e:')).map(([, e]) => e);
    all.sort((a, b) => a.at.localeCompare(b.at));
    vecs.clear(); evs.clear();
    for (const { vec, ...e } of all) { if (vec) vecs.set(e.id, vec); evs.set(e.id, e); }
    order = all.map((e) => e.id);
  })(), () => { memP = null; }));
  return order.map((id) => evs.get(id));
}

Comlink.expose({
  async loadAsr(model, opts, onProgress) {
    const { pipeline } = await tf();
    asr = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback: tracker(onProgress, 'Loading ears') });
  },
  async transcribe(audio, o) {
    const out = await serial('asr', () => asr(audio, o));
    return (Array.isArray(out) ? out[0]?.text : out?.text) || '';
  },

  async embed(text) { const v = await embedVec(text); return Comlink.transfer(v, [v.buffer]); },
  entities,

  // Graph memory: events (without vectors) for the main thread's timeline and entity index.
  memLoad,
  async memAdd(e) {
    await memLoad();
    const ents = await entities(e.text);
    let vec = null;
    try { vec = await embedVec(`${e.kind}: ${e.text}`); } catch {}
    if (vec) vecs.set(e.id, vec);
    evs.set(e.id, { ...e, ents });
    order.push(e.id);
    const drop = order.length > MAX_EVENTS ? order.splice(0, order.length - MAX_EVENTS) : [];
    for (const id of drop) { vecs.delete(id); evs.delete(id); }
    const db = await memDb();
    db.setMany([[`e:${e.id}`, { ...e, ents, vec }], ['meta', { v: 1, count: order.length }]], store)
      .then(() => drop.length && db.delMany(drop.map((id) => `e:${id}`), store)).catch(() => {});
    return ents;
  },
  // Top-k by cosine (vectors are normalized, so a dot product) over Float32Arrays, plus the query's entities.
  async memSearch(query, k = 5, minScore = 0.3) {
    await memLoad();
    const [q, ents] = await Promise.all([embedVec(query).catch(() => null), entities(query)]);
    const hits = [];
    if (q) {
      for (const [id, v] of vecs) {
        let s = 0;
        for (let i = 0; i < v.length; i++) s += q[i] * v[i];
        if (s > minScore) hits.push([id, s]);
      }
      hits.sort((a, b) => b[1] - a[1]);
    }
    return { hits: hits.slice(0, k), ents };
  },
  async memClear() {
    const db = await memDb();
    await memLoad();
    vecs.clear(); evs.clear(); order = [];
    await db.clear(store);
    await db.set('meta', { v: 1, count: 0 }, store);
    try { await db.del('g:events'); } catch {}
  },

  // SmolVLM-256M scene captioner. frame: image data URL or Blob, decoded here with RawImage.
  async loadCaptioner({ device = 'wasm' } = {}, onProgress) {
    capP ||= once((async () => {
      const { AutoProcessor, AutoModelForVision2Seq } = await tf();
      const progress_callback = tracker(onProgress, 'Loading vision model');
      const processor = await AutoProcessor.from_pretrained(VLM, { progress_callback });
      const opts = { dtype: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }, progress_callback };
      let model;
      try { model = await AutoModelForVision2Seq.from_pretrained(VLM, { ...opts, device }); } catch (e) {
        if (device === 'wasm') throw e;
        model = await AutoModelForVision2Seq.from_pretrained(VLM, { ...opts, device: 'wasm' });
      }
      return { processor, model };
    })(), () => { capP = null; });
    await capP;
  },
  async caption(frame, { prompt = VLM_PROMPT, maxNewTokens = 48 } = {}) {
    if (!capP || !frame) return '';
    const [{ processor, model }, { RawImage }] = await Promise.all([capP, tf()]);
    const image = typeof frame === 'string' ? await RawImage.fromURL(frame) : await RawImage.fromBlob(frame);
    return serial('vlm', async () => {
      const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
      const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
      const inputs = await processor(text, [image], { do_image_splitting: false });
      const out = await model.generate({ ...inputs, max_new_tokens: maxNewTokens });
      const [c] = processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true });
      return (c || '').trim();
    });
  },

  // Translators: modelKey 'de-en' | 'en-de' | 'nllb'. Opus-MT drops everything after the first sentence,
  // so it translates per sentence (opts.perSentence, default on for Opus-MT). Other opts go to the pipeline
  // (NLLB needs src_lang / tgt_lang).
  async loadTranslator(modelKey, onProgress, label = 'Loading translator') { await translatorFor(modelKey, onProgress, label); },
  async translate(modelKey, text, opts = {}) {
    if (!text?.trim()) return '';
    const { perSentence = modelKey !== 'nllb', ...gen } = opts;
    const pipe = await translatorFor(modelKey);
    return serial(modelKey, async () => {
      const out = [];
      for (const p of perSentence ? sentences(text) : [text]) {
        const [r] = await pipe(p, gen);
        if (r?.translation_text) out.push(r.translation_text.trim());
      }
      return out.join(' ');
    });
  },

  // Kokoro TTS: onProgress receives (fraction, label).
  async loadTts(id, opts, onProgress) {
    const { KokoroTTS } = await import(KOKORO);
    tts = await KokoroTTS.from_pretrained(id, { ...opts, progress_callback: tracker(onProgress, 'Loading voice') });
  },
  async speak(text, voice) {
    const r = await serial('tts', () => tts.generate(text, { voice }));
    return Comlink.transfer({ audio: r.audio, sampling_rate: r.sampling_rate }, [r.audio.buffer]);
  },
});
