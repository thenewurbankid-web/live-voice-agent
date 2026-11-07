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

function thumb(dataUrl, max = 320) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: img.width * k, height: img.height * k });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}

export class Memory {
  async load() {
    const { get } = await db();
    this.facts = (await get('mem:facts')) || [];
    this.turns = (await get('mem:turns')) || [];   // [{ id, at, who, text, image?, clip? }]
    try { await navigator.storage?.persist?.(); } catch {}
    return this;
  }

  async _save() {
    const { set, del } = await db();
    // cap images / clips (oldest first) and turns
    let imgs = 0, clips = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.image && ++imgs > LIMITS.images) delete t.image;
      if (t.clip && ++clips > LIMITS.clips) { await del('mem:clip:' + t.clip); delete t.clip; }
    }
    this.turns = this.turns.slice(-LIMITS.turns);
    await set('mem:turns', this.turns);
    await set('mem:facts', this.facts.slice(-LIMITS.facts));
  }

  async addTurn(who, text, { image = null, audio = null } = {}) {
    const t = { id: Date.now() + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), who, text };
    if (image) t.image = await thumb(image);
    if (audio) { t.clip = t.id; (await db()).set('mem:clip:' + t.id, toWav(audio)); }
    this.turns.push(t);
    await this._save();
    return t;
  }

  async clip(id) { return (await db()).get('mem:clip:' + id); }

  async remember(fact) { this.facts.push({ at: new Date().toISOString(), text: fact }); await this._save(); }

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
    await clear(); this.facts = []; this.turns = [];
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
