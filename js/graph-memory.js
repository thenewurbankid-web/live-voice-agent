// GraphRAG-style memory on the device: a timeline of what was said / seen / heard, an entity graph over it
// (compromise.js NLP), and semantic retrieval (MiniLM embeddings via transformers.js). Embedding, entity
// extraction, the Float32Array vector search and IndexedDB persistence (one key per event) all run in the
// shared ML worker; this thread keeps only the timeline and the entity → event index.
import { getMlWorker } from './ml.js';

export class GraphMemory {
  async load() {
    this.ml = getMlWorker();
    this.events = await this.ml.memLoad();             // [{ id, at, kind, text, ents: [] }] (vectors stay in the worker)
    this.index = new Map();                             // entity → event ids
    for (const e of this.events) this._link(e);
    this.byId = new Map(this.events.map((e) => [e.id, e]));
    return this;
  }

  _link(e) { for (const n of e.ents || []) (this.index.get(n) || this.index.set(n, []).get(n)).push(e.id); }

  // kind: 'said' (user) | 'reply' (assistant) | 'saw' (scene caption) | 'heard' (sound labels) | 'plan' | 'fact'
  async add(kind, text) {
    if (!text?.trim()) return;
    this.ml ||= getMlWorker();
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), kind, text: text.slice(0, 400) };
    e.ents = await this.ml.memAdd(e);                   // entities + embedding + persistence, in the worker
    this.events.push(e); this.byId.set(e.id, e);
    this._link(e);
    if (this.events.length > 5000) for (const old of this.events.splice(0, this.events.length - 5000)) this.byId.delete(old.id);
  }

  // Top-k semantically similar moments, expanded one hop through shared entities (the "graph" part).
  async retrieve(query, k = 5) {
    if (!this.events.length) return [];
    this.ml ||= getMlWorker();
    const { hits: scored, ents: qEnts } = await this.ml.memSearch(query, k);
    const hits = scored.map(([id]) => this.byId.get(id)).filter(Boolean);
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
  async clear() {
    this.events = []; this.index.clear(); this.byId.clear();
    try { await (this.ml || getMlWorker()).memClear(); } catch {}
  }
}
