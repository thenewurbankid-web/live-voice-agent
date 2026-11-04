// GraphRAG-style memory on the device: a timeline of what was said / seen / heard, an entity graph over it
// (compromise.js NLP), and semantic retrieval (MiniLM embeddings via transformers.js). Stored in IndexedDB.
const IDB = 'https://cdn.jsdelivr.net/npm/idb-keyval@6.3.0/+esm';
const NLP = 'https://cdn.jsdelivr.net/npm/compromise@14.19.0/+esm';
const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';
const MAX_EVENTS = 5000;
const STOP = new Set(['i', 'you', 'me', 'it', 'that', 'this', 'thing', 'things', 'something', 'image', 'picture', 'camera', 'time', 'way', 'lot']);

let kv, nlp;
const db = async () => (kv ||= await import(IDB));

export class GraphMemory {
  async load() {
    const { get } = await db();
    this.events = (await get('g:events')) || [];       // [{ id, at, kind, text, ents: [], vec?: number[] }]
    this.index = new Map();                             // entity → event ids
    for (const e of this.events) for (const n of e.ents) (this.index.get(n) || this.index.set(n, []).get(n)).push(e.id);
    this.byId = new Map(this.events.map((e) => [e.id, e]));
    return this;
  }

  async _embedder() {
    if (this.embedP) return this.embedP;
    this.embedP = import(TRANSFORMERS).then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', device: 'wasm' }));
    return this.embedP;
  }
  async _embed(text) {
    try { const f = await this._embedder(); const t = await f(text, { pooling: 'mean', normalize: true }); return Array.from(t.data, (x) => Math.round(x * 1e4) / 1e4); }
    catch { return null; }
  }

  async _entities(text) {
    try {
      nlp ||= (await import(NLP)).default;
      const doc = nlp(text);
      const out = [...doc.people().out('array'), ...doc.places().out('array'), ...doc.organizations().out('array'), ...doc.nouns().toSingular().out('array')]
        .map((s) => s.toLowerCase().replace(/^(the|a|an|my|your|some)\s+/, '').replace(/[^\p{L}\p{N} '-]/gu, '').trim())
        .filter((s) => s.length > 2 && s.split(' ').length <= 3 && !STOP.has(s));
      return [...new Set(out)].slice(0, 8);
    } catch { return []; }
  }

  // kind: 'said' (user) | 'reply' (assistant) | 'saw' (scene caption) | 'heard' (sound labels) | 'plan' | 'fact'
  async add(kind, text) {
    if (!text?.trim()) return;
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), kind, text: text.slice(0, 400) };
    e.ents = await this._entities(e.text);
    e.vec = await this._embed(`${kind}: ${e.text}`);
    this.events.push(e); this.byId.set(e.id, e);
    for (const n of e.ents) (this.index.get(n) || this.index.set(n, []).get(n)).push(e.id);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    clearTimeout(this.saveT);
    this.saveT = setTimeout(async () => { try { (await db()).set('g:events', this.events); } catch {} }, 800);
  }

  // Top-k semantically similar moments, expanded one hop through shared entities (the "graph" part).
  async retrieve(query, k = 5) {
    if (!this.events.length) return [];
    const q = await this._embed(query);
    const scored = q ? this.events.filter((e) => e.vec).map((e) => [e, dot(q, e.vec)]) : [];
    scored.sort((a, b) => b[1] - a[1]);
    const hits = scored.slice(0, k).filter(([, s]) => s > 0.3).map(([e]) => e);
    const qEnts = await this._entities(query);
    const seen = new Set(hits.map((e) => e.id));
    for (const n of [...qEnts, ...hits.flatMap((e) => e.ents)]) {
      for (const id of (this.index.get(n) || []).slice(-2)) {
        if (seen.size >= k + 4) break;
        if (!seen.has(id) && this.byId.get(id)) { seen.add(id); hits.push(this.byId.get(id)); }
      }
    }
    return hits.sort((a, b) => a.at.localeCompare(b.at));
  }

  async contextFor(query) {
    const hits = await this.retrieve(query);
    if (!hits.length) return '';
    const label = { said: 'User said', reply: 'You said', saw: 'You saw', heard: 'You heard', plan: 'Plan', fact: 'Fact' };
    return 'Relevant memories from earlier (on this device):\n' + hits.map((e) =>
      `- ${new Date(e.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${label[e.kind] || e.kind}: ${e.text}`).join('\n');
  }

  timeline(n = 80) { return this.events.slice(-n); }
  async clear() { this.events = []; this.index.clear(); this.byId.clear(); try { (await db()).del('g:events'); } catch {} }
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
