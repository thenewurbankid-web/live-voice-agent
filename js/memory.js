// Persistent on-device memory (IndexedDB via idb-keyval): facts, conversation, images, voice clips.
const IDB = 'https://cdn.jsdelivr.net/npm/idb-keyval@6.3.0/+esm';
const LIMITS = { turns: 200, images: 40, clips: 30, facts: 50, recBytes: 300 * 1024 * 1024 };

let kv;
const db = async () => (kv ||= await import(IDB));

// 16 kHz Float32 PCM → WAV Blob (Web Audio native format, no codec library needed)
function toWav(f32, rate = 16000) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, f32.length * 2, true);
  f32.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}

// Camera frame (data URL) → small JPEG Blob. Stored under its own key, never inside the turns index.
function thumb(dataUrl, max = 320) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => res(b), 'image/jpeg', 0.6);
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}
const dataUrlToBlob = (u) => fetch(u).then((r) => r.blob()).catch(() => null);

export class Memory {
  constructor() {
    // Flush the debounced turns index before the page can be killed in the background.
    addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
    addEventListener('pagehide', () => this.flush());
  }

  async load() {
    const { get } = await db();
    this.facts = (await get('mem:facts')) || [];
    this.turns = (await get('mem:turns')) || [];   // [{ id, at, who, text, img?, clip? }] (old turns: image = base64 data URL)
    try { await navigator.storage?.persist?.(); } catch {}
    setTimeout(() => this._migrate().catch(() => {}), 2000);   // move old base64 thumbnails out of the index, off the startup path
    return this;
  }

  // Old turns kept their thumbnail inline as base64; move each into its own Blob key.
  async _migrateTurn(t) {
    if (typeof t.image !== 'string') return false;
    const blob = t.image.startsWith('data:') ? await dataUrlToBlob(t.image) : null;
    if (blob) await (await db()).set('mem:img:' + t.id, blob);
    delete t.image;
    if (blob) t.img = t.id;
    return true;
  }
  async _migrate() {
    let n = 0;
    for (const t of this.turns || []) if (await this._migrateTurn(t)) n++;
    if (n) this._queueSave();
  }

  // The turns index is saved at most once a second, not on every turn.
  _queueSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.flush(), 1000);
  }
  flush() {
    clearTimeout(this.saveT); this.saveT = null;
    return (this.saveQ = (this.saveQ || Promise.resolve()).then(() => this._saveTurns()).catch(() => {}));
  }

  async _saveTurns() {
    if (!this.turns) return;
    const { set, del } = await db();
    // cap images / clips (oldest first) and turns; their blobs go with them
    let imgs = 0, clips = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.image && ++imgs > LIMITS.images) delete t.image;
      if (t.img && ++imgs > LIMITS.images) { await del('mem:img:' + t.img); delete t.img; }
      if (t.clip && ++clips > LIMITS.clips) { await del('mem:clip:' + t.clip); delete t.clip; }
    }
    const drop = this.turns.length - LIMITS.turns;
    for (const t of drop > 0 ? this.turns.slice(0, drop) : []) {
      if (t.img) await del('mem:img:' + t.img);
      if (t.clip) await del('mem:clip:' + t.clip);
    }
    if (drop > 0) this.turns = this.turns.slice(drop);
    await set('mem:turns', this.turns);
  }

  async _saveFacts() { await (await db()).set('mem:facts', this.facts.slice(-LIMITS.facts)); }

  async addTurn(who, text, { image = null, audio = null } = {}) {
    const t = { id: Date.now() + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), who, text };
    const { set } = await db();
    if (image) { const b = await thumb(image); if (b) { await set('mem:img:' + t.id, b); t.img = t.id; } }
    if (audio) { t.clip = t.id; set('mem:clip:' + t.id, toWav(audio)); }
    this.turns.push(t);
    this._queueSave();
    return t;
  }

  // Thumbnail Blob for a turn (old base64 turns are migrated the first time they are read).
  async image(id) {
    const { get } = await db();
    const hit = await get('mem:img:' + id);
    if (hit) return hit;
    const t = this.turns?.find((x) => x.id === id || x.img === id);
    if (t && await this._migrateTurn(t)) { this._queueSave(); return t.img ? get('mem:img:' + t.img) : null; }
    return null;
  }

  async clip(id) { return (await db()).get('mem:clip:' + id); }

  async remember(fact) { this.facts.push({ at: new Date().toISOString(), text: fact }); await this._saveFacts(); }

  // ---- continuous conversation recordings (MediaRecorder chunks) ----
  // Chunks arrive every few seconds; saves run one at a time so they never overwrite each other's index.
  addChunk(sessionId, blob, mime) {
    return (this.recQ = (this.recQ || Promise.resolve()).then(() => this._addChunk(sessionId, blob, mime)).catch(() => {}));
  }
  async _addChunk(sessionId, blob, mime) {
    const { get, set, del } = await db();
    const recs = (await get('mem:recs')) || [];           // [{ id, start, mime, chunks: n, bytes }]
    let r = recs.find((x) => x.id === sessionId);
    if (!r) { r = { id: sessionId, start: new Date().toISOString(), mime, chunks: 0, bytes: 0 }; recs.push(r); }
    await set(`mem:rec:${sessionId}:${r.chunks}`, blob);
    r.chunks++; r.bytes += blob.size; r.end = new Date().toISOString();
    // cap total size: drop the oldest recordings first
    let total = recs.reduce((a, x) => a + x.bytes, 0);
    while (total > LIMITS.recBytes && recs.length > 1) {
      const old = recs.shift(); total -= old.bytes;
      for (let i = 0; i < old.chunks; i++) await del(`mem:rec:${old.id}:${i}`);
    }
    await set('mem:recs', recs);
  }

  async recordings() { return ((await (await db()).get('mem:recs')) || []).slice().reverse(); }

  async recording(id) {
    const { get } = await db();
    const r = ((await get('mem:recs')) || []).find((x) => x.id === id);
    if (!r) return null;
    const parts = [];
    for (let i = 0; i < r.chunks; i++) { const b = await get(`mem:rec:${id}:${i}`); if (b) parts.push(b); }
    return new Blob(parts, { type: r.mime });
  }

  async forgetAll() {
    const { clear } = await db();
    clearTimeout(this.saveT); this.saveT = null;
    await this.saveQ; await clear(); this.facts = []; this.turns = [];
  }

  // Context handed to the brain: known facts + a few recent exchanges from earlier sessions.
  context() {
    const facts = this.facts.map((f) => '- ' + f.text).join('\n');
    return facts ? `Things the user asked you to remember:\n${facts}` : '';
  }

  // Seed the brain's chat history with the last exchanges, so it remembers across visits.
  recentHistory(n = 6) {
    return this.turns.filter((t) => t.who === 'You' || t.who === 'AI').slice(-n)
      .map((t) => ({ role: t.who === 'You' ? 'user' : 'assistant', content: t.text }));
  }
}
