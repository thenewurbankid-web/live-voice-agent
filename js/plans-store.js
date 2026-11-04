// Plans persistence: IndexedDB via idb-keyval (OSS, CDN-pinned), single key 'plans'.
const IDB = 'https://cdn.jsdelivr.net/npm/idb-keyval@6.3.0/+esm';
const KEY = 'plans';

let idbP = null;
const idb = () => (idbP ??= import(IDB));

export class PlansStore {
  async #all() { return (await (await idb()).get(KEY)) || []; }
  async #write(arr) { await (await idb()).set(KEY, arr); }

  async list() {
    return (await this.#all()).slice().sort((a, b) => String(b.created).localeCompare(String(a.created)));
  }
  async get(id) { return (await this.#all()).find(p => p.id === id) || null; }
  async save(plan) {
    const all = await this.#all();
    const i = all.findIndex(p => p.id === plan.id);
    if (i >= 0) all[i] = plan; else all.push(plan);
    await this.#write(all);
    return plan;
  }
  async remove(id) { await this.#write((await this.#all()).filter(p => p.id !== id)); }
  async active() {
    const a = (await this.list()).filter(p => p.status === 'active');
    return a[0] || null;
  }
}
