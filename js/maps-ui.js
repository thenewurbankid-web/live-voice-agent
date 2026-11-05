// Google-Maps-like full-screen screen: search, results, place card, directions, follow-me navigation.
// All collaborators are injected (see CONTRACTS.md, Phase 3). Imports nothing from app.js.
import { CATEGORIES } from './places.js';

const OH = 'https://cdn.jsdelivr.net/npm/opening_hours@3.15.0/+esm'; // same pin as planner.js
let ohP = null;
const loadOH = () => (ohP ??= import(OH).then(m => m.default || m.opening_hours || m).catch(() => null));

async function openState(place, when = new Date()) { // true | false | null
  const spec = place?.tags?.opening_hours;
  if (!spec) return null;
  const C = await loadOH();
  if (!C) return null;
  try { return !!new C(spec, { lat: place.lat, lon: place.lng, address: { country_code: 'de', state: 'Berlin' } }).getState(when); }
  catch { return null; }
}

const CSS = `
.mui{position:fixed;inset:0;z-index:5;pointer-events:none;color:var(--ink,#f2f4f8);font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--sheet-h:120px;overflow:hidden}
.mui.hidden,.mui .hidden{display:none!important}
.mui *{box-sizing:border-box}
.mui button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
.mui>*{pointer-events:auto}
.mui-top{position:absolute;left:0;right:0;top:0;padding:calc(10px + var(--safe-t,0px)) 10px 0;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.mui-top>*{pointer-events:auto}
.mui-bar{display:flex;align-items:center;gap:2px;background:var(--panel,#151922);border:1px solid var(--line,#252b37);border-radius:99px;padding:4px 6px;box-shadow:0 4px 18px rgba(0,0,0,.45)}
.mui-bar input{flex:1;min-width:0;background:transparent;border:0;outline:0;font-size:16px;padding:10px 6px;color:var(--ink,#f2f4f8)}
.mui-ib{width:40px;height:40px;border-radius:50%;border:0;background:transparent;display:grid;place-items:center;flex:none}
.mui-ib svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mui-chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:2px 2px 4px}
.mui-chips::-webkit-scrollbar{display:none}
.mui-chip{flex:none;border:1px solid var(--line,#252b37);background:var(--panel,#151922);border-radius:99px;padding:7px 13px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap}
.mui-chip.on{background:var(--accent,#7aa2ff);color:#0b0d12;border-color:var(--accent,#7aa2ff);font-weight:600}
.mui-fabs{position:absolute;right:12px;bottom:calc(var(--sheet-h) + 12px);display:flex;flex-direction:column;gap:10px;transition:bottom .2s;pointer-events:none}
.mui-fabs>*{pointer-events:auto}
.mui-fab{width:48px;height:48px;border-radius:50%;border:1px solid var(--line,#252b37);background:var(--panel,#151922);display:grid;place-items:center;box-shadow:0 3px 12px rgba(0,0,0,.45);font-size:12px;font-weight:700}
.mui-fab svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mui-fab.on{background:var(--accent,#7aa2ff);color:#0b0d12}
.mui-sheet{position:absolute;left:0;right:0;bottom:0;height:120px;background:var(--panel,#151922);border-radius:20px 20px 0 0;border-top:1px solid var(--line,#252b37);box-shadow:0 -6px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;transition:height .25s cubic-bezier(.2,.8,.2,1);max-width:640px;margin:0 auto;padding-bottom:var(--safe-b,0px)}
.mui-sheet.drag{transition:none}
.mui-grip{touch-action:none;padding:8px 14px 6px;cursor:grab;flex:none}
.mui-grip i{display:block;width:40px;height:5px;border-radius:99px;background:var(--line,#252b37);margin:0 auto 8px;filter:brightness(1.8)}
.mui-h{font-weight:600;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mui-sub{color:var(--mute,#9aa3b2);font-size:13px}
.mui-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:0 14px 14px;display:flex;flex-direction:column;gap:10px;min-height:0}
.mui-res{list-style:none;margin:0;padding:0}
.mui-res li{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line,#252b37);cursor:pointer}
.mui-pin{width:32px;height:32px;border-radius:50%;background:#ea5b5b;color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.mui-res .t{flex:1;min-width:0}.mui-res .t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mui-open{color:var(--ok,#38d39f);font-weight:600}.mui-closed{color:var(--bad,#ff6b6b);font-weight:600}
.mui-acts{display:flex;gap:8px;flex-wrap:wrap}
.mui-btn{border:1px solid var(--line,#252b37);background:var(--bg,#0b0d12);border-radius:99px;padding:10px 16px;min-height:42px;font-weight:600}
.mui-btn.pri{background:var(--accent,#7aa2ff);color:#0b0d12;border-color:var(--accent,#7aa2ff)}
.mui-btn.bad{color:var(--bad,#ff6b6b)}
.mui-badge{display:inline-block;font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid var(--line,#252b37);margin-left:6px;vertical-align:middle}
.mui-badge.on{color:var(--ok,#38d39f);border-color:var(--ok,#38d39f)}.mui-badge.off{color:#c9a4ff;border-color:#8a5cf0}
.mui-ft{display:flex;flex-direction:column;gap:6px;background:var(--bg,#0b0d12);border:1px solid var(--line,#252b37);border-radius:14px;padding:8px 12px}
.mui-ft label{display:flex;gap:10px;align-items:center}.mui-ft label span{color:var(--mute,#9aa3b2);width:34px;font-size:13px}
.mui-ft input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--ink,#f2f4f8);font-size:15px;padding:6px 0}
.mui-steps{list-style:none;margin:0;padding:0;counter-reset:s}
.mui-steps li{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line,#252b37)}
.mui-steps li::before{counter-increment:s;content:counter(s);width:22px;height:22px;border-radius:50%;background:var(--line,#252b37);display:grid;place-items:center;font-size:11px;flex:none;margin-top:1px}
.mui-steps li.cur{color:var(--accent,#7aa2ff);font-weight:600}
.mui-banner{position:absolute;left:10px;right:10px;top:calc(10px + var(--safe-t,0px));background:#1a73e8;color:#fff;border-radius:18px;padding:14px 16px;box-shadow:0 6px 22px rgba(0,0,0,.5);max-width:620px;margin:0 auto}
.mui-banner b{display:block;font-size:20px;line-height:1.25}.mui-banner small{opacity:.85}
.mui-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--sheet-h) + 70px);background:#000d;color:#fff;border-radius:99px;padding:9px 16px;font-size:14px;pointer-events:none;max-width:90%}
.mui-empty{color:var(--mute,#9aa3b2);text-align:center;padding:22px 0}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'mui-btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; };
const ICON = {
  back: '<path d="M15 5l-7 7 7 7"/>', mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  nav: '<path d="M12 3l7 17-7-4-7 4z"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
};
const icon = k => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICON[k]; return s; };
const iconBtn = (k, label, fn, cls = 'mui-ib') => { const b = el('button', cls); b.type = 'button'; b.setAttribute('aria-label', label); b.appendChild(icon(k)); b.onclick = fn; return b; };

const WALK_MPS = 4.8 / 3.6;
const fmtDist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10 || 10} m`);
const fmtMin = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const haversine = (a, b) => {
  const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const catLabel = k => CATEGORIES.find(c => c.key === k)?.label.replace(/s$/, '') || (k ? k[0].toUpperCase() + k.slice(1) : 'Place');

// keyword → category keys
const KEYWORDS = [
  [/\b(bars?)\b/, ['bar']], [/\b(pubs?)\b/, ['pub']], [/\b(cafes?|coffee)\b/, ['cafe']],
  [/\b(food|restaurants?|eat|dinner|lunch)\b/, ['restaurant']], [/\b(sights?|attractions?|sightseeing)\b/, ['sight']],
  [/\b(museums?|galleries|gallery)\b/, ['museum']], [/\b(parks?)\b/, ['park']], [/\b(clubs?|nightclubs?)\b/, ['club']],
  [/\b(biergarten|biergartens|beer gardens?)\b/, ['biergarten']],
];

export class MapsUI {
  constructor(rootEl, deps) {
    this.root = rootEl;
    this.d = deps;
    this.view = 'results';
    this.stack = [];
    this.snap = 'peek';
    this.results = [];
    this.title = '';
    this.place = null;
    this.rt = null; this.from = null; this.to = null;
    this.me = null;
    this.navigating = false; this.lastStep = -1;
    this.planLayer = false;
    this.activeChip = null;
    this.nav = null;
    if (!document.getElementById('maps-ui-css')) {
      const s = document.createElement('style'); s.id = 'maps-ui-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    this.root.classList.add('mui', 'hidden');
    this._build();
  }

  get online() { return !!this.d.getOnline?.(); }
  get deps() { return { places: this.d.places, route: this.d.route, online: this.online }; }

  // ---------- skeleton ----------
  _build() {
    const r = this.root;
    r.textContent = '';
    // top: search bar + chips
    this.top = el('div', 'mui-top');
    const bar = el('div', 'mui-bar');
    this.backBtn = iconBtn('back', 'Back', () => this._back());
    this.input = el('input'); this.input.type = 'search'; this.input.placeholder = 'Search Berlin'; this.input.enterKeyHint = 'search';
    this.input.setAttribute('aria-label', 'Search places');
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.input.blur(); this.search(this.input.value); } });
    bar.append(this.backBtn, this.input);
    if (this.d.onMic) bar.append(iconBtn('mic', 'Voice search', () => this.d.onMic(this)));
    this.chips = el('div', 'mui-chips');
    const plans = el('button', 'mui-chip', 'Plans'); plans.type = 'button'; plans.onclick = () => this.d.openPlans?.('active');
    this.chips.appendChild(plans);
    for (const c of CATEGORIES) {
      const b = el('button', 'mui-chip', c.label); b.type = 'button'; b.dataset.cat = c.key;
      b.onclick = () => { this.input.value = c.label; this._searchCats([c.key], c.label); };
      this.chips.appendChild(b);
    }
    this.top.append(bar, this.chips);
    // fabs
    this.fabs = el('div', 'mui-fabs');
    this.fabPlan = el('button', 'mui-fab', 'Plan'); this.fabPlan.type = 'button'; this.fabPlan.onclick = () => this._togglePlanLayer();
    this.fabRecenter = iconBtn('nav', 'Recenter', () => { this.d.map.follow?.(true); this._markFollow(true); }, 'mui-fab hidden');
    this.fabLocate = iconBtn('locate', 'My location', () => this.locate(), 'mui-fab');
    this.fabs.append(this.fabPlan, this.fabRecenter, this.fabLocate);
    // nav banner
    this.banner = el('div', 'mui-banner hidden');
    this.banner.append(el('b'), el('small'));
    // sheet
    this.sheet = el('div', 'mui-sheet');
    this.grip = el('div', 'mui-grip');
    this.grip.append(el('i'), el('div', 'mui-h'), el('div', 'mui-sub'));
    this.body = el('div', 'mui-body');
    this.sheet.append(this.grip, this.body);
    this.toastEl = el('div', 'mui-toast hidden');
    r.append(this.top, this.banner, this.fabs, this.sheet, this.toastEl);
    this._dragInit();
    window.addEventListener('resize', () => this._applySnap());
  }

  // ---------- sheet (peek / half / full) ----------
  _snaps() {
    const H = this.root.clientHeight || innerHeight;
    return { peek: 120, half: Math.round(H * 0.5), full: Math.max(300, H - 130) };
  }
  _setH(px) {
    this.sheet.style.height = px + 'px';
    this.root.style.setProperty('--sheet-h', Math.min(px, this._snaps().half) + 'px');
    this.fabs.style.display = px > this._snaps().half + 40 ? 'none' : '';
  }
  _applySnap(snap = this.snap) { this.snap = snap; this._setH(this._snaps()[snap]); }
  setSnap(s) { this._applySnap(s); }

  _dragInit() {
    let y0 = 0, h0 = 0, t0 = 0, moved = false, id = null, lastY = 0, lastT = 0, v = 0;
    this.grip.addEventListener('pointerdown', (e) => {
      id = e.pointerId; this.grip.setPointerCapture(id);
      y0 = lastY = e.clientY; h0 = this.sheet.offsetHeight; t0 = lastT = performance.now(); moved = false; v = 0;
      this.sheet.classList.add('drag');
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (id !== e.pointerId) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) moved = true;
      const now = performance.now();
      if (now > lastT) v = (lastY - e.clientY) / (now - lastT); // px/ms, + = up
      lastY = e.clientY; lastT = now;
      const s = this._snaps();
      this._setH(Math.max(80, Math.min(s.full, h0 - dy)));
    });
    const end = (e) => {
      if (id !== e.pointerId) return;
      id = null; this.sheet.classList.remove('drag');
      const s = this._snaps();
      if (!moved) { this._applySnap(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'half'); return; }
      const target = this.sheet.offsetHeight + v * 180;
      let best = 'peek', bd = Infinity;
      for (const k of ['peek', 'half', 'full']) { const d = Math.abs(s[k] - target); if (d < bd) { bd = d; best = k; } }
      this._applySnap(best);
    };
    this.grip.addEventListener('pointerup', end);
    this.grip.addEventListener('pointercancel', end);
  }

  _head(title, sub) {
    this.grip.children[1].textContent = title || '';
    this.grip.children[2].textContent = sub || '';
  }
  _toast(msg) {
    this.toastEl.textContent = msg; this.toastEl.classList.remove('hidden');
    clearTimeout(this._tt); this._tt = setTimeout(() => this.toastEl.classList.add('hidden'), 2600);
  }
  _markFollow(on) { this.fabRecenter.classList.toggle('hidden', !(this.navigating && !on)); }

  // ---------- lifecycle ----------
  async open({ query = '', place = null } = {}) {
    this.root.classList.remove('hidden');
    try { await this.d.map.show?.(); } catch (e) { console.warn('maps-ui: map failed', e); }
    this.d.map.onLongPress?.(({ lng, lat }) => this._pin(lng, lat));
    if (this.d.map.map && !this._followHook) { this._followHook = true; this.d.map.onFollowChange = on => this._markFollow(on); }
    this._applySnap('peek');
    this._home();
    this.d.Navigator.here().then(h => { if (h) { this.me = h; this.d.map.showUser?.(h.lng, h.lat); } }).catch(() => {});
    if (place) await this.showPlace(place);
    else if (query) { this.input.value = query; await this.search(query); }
  }

  close() {
    this._endNav();
    this.d.map.clearResults?.(); this.d.map.clearRoute?.();
    if (this.planLayer) { this.d.map.clearPlan?.(); this.planLayer = false; this.fabPlan.classList.remove('on'); }
    this.root.classList.add('hidden');
  }

  _home() {
    this.stack = []; this.view = 'results'; this.results = []; this.title = '';
    this._head('Explore Berlin', 'Search or pick a category');
    this.body.textContent = '';
    this.body.appendChild(el('div', 'mui-empty', 'Try "bars in Kreuzberg", "museums" or a place name.'));
    this.backBtn.replaceChildren(icon('close'));
    this.d.map.clearResults?.(); this.d.map.clearRoute?.();
    this._chip(null);
  }

  _chip(key) {
    this.activeChip = key;
    this.chips.querySelectorAll('.mui-chip[data-cat]').forEach(c => c.classList.toggle('on', c.dataset.cat === key));
  }

  _push() { this.stack.push({ view: this.view, results: this.results, title: this.title, place: this.place }); this.backBtn.replaceChildren(icon('back')); }

  async _back() {
    if (this.navigating) return this._endNav(true);
    const prev = this.stack.pop();
    this.d.map.clearRoute?.();
    if (!prev) { if (this.view === 'results' && !this.results.length) return this.close(); return this._home(); }
    if (!this.stack.length && prev.view === 'results' && !prev.results.length) return this._home();
    if (!this.stack.length) this.backBtn.replaceChildren(icon('back'));
    this.place = prev.place;
    if (prev.view === 'results') { this.results = prev.results; this.title = prev.title; this._renderResults(); }
    else if (prev.view === 'place') this._renderPlace(prev.place);
  }

  async locate() {
    const h = await this.d.Navigator.here();
    if (!h) return this._toast('Location unavailable');
    this.me = h;
    this.d.map.showUser?.(h.lng, h.lat);
    this.d.map.flyTo(h.lng, h.lat, 16);
  }

  // ---------- search ----------
  _center() {
    if (this.me) return this.me;
    const c = this.d.map.map?.getCenter?.();
    return c ? { lng: c.lng, lat: c.lat } : { lng: 13.405, lat: 52.52 };
  }

  async search(query) {
    const raw = String(query || '').trim();
    if (!raw) return;
    const q = norm(raw);
    let cats = null;
    for (const [re, keys] of KEYWORDS) if (re.test(q)) { cats = keys; break; }
    // area after in/near/at/around
    const m = q.match(/\b(?:in|near|at|around|by)\s+(.+)$/);
    let near = null, area = '';
    if (m && cats) {
      const g = await this.d.places.geocode(m[1], { online: this.online });
      if (g) { near = g; area = g.label; }
    }
    if (cats) return this._searchCats(cats, raw, near, area);
    // name or area
    const near2 = this._center();
    const byName = await this.d.places.search({ query: raw, near: near2, radiusM: 40000, limit: 30, online: false }).catch(() => []);
    if (byName.length) return this._showResults(byName, raw);
    const g = await this.d.places.geocode(raw, { online: this.online });
    if (g) {
      this.d.map.flyTo(g.lng, g.lat, 15);
      return this._showResults([{ id: 'geo:' + g.label, name: g.label, cat: null, lng: g.lng, lat: g.lat, tags: {}, distanceM: this.me ? Math.round(haversine(this.me, g)) : undefined }], raw);
    }
    this._showResults([], raw);
  }

  async _searchCats(cats, label, near = null, area = '') {
    this._chip(cats.length === 1 && CATEGORIES.some(c => c.key === cats[0]) && label === CATEGORIES.find(c => c.key === cats[0]).label ? cats[0] : null);
    const c = near || this._center();
    let list = await this.d.places.search({ cats, near: c, radiusM: 2500, limit: 30, online: this.online }).catch(() => []);
    if (list.length < 3) list = await this.d.places.search({ cats, near: c, radiusM: 8000, limit: 30, online: false }).catch(() => list);
    if (near) this.d.map.flyTo(c.lng, c.lat, 14.5);
    // distances from me when known (list is sorted from the search centre)
    this._showResults(list, area ? `${label}` : label, area);
  }

  _showResults(list, title) {
    if (this.view !== 'results' || this.results.length || this.stack.length) { /* replace the current list, keep stack depth */ }
    this.view = 'results'; this.results = list; this.title = title; this.place = null; this.stack = [];
    this.backBtn.replaceChildren(icon('back'));
    this._renderResults();
    this.d.map.setResults?.(list, p => this.showPlace(p));
    if (list.length) {
      const b = list.reduce((a, p) => [[Math.min(a[0][0], p.lng), Math.min(a[0][1], p.lat)], [Math.max(a[1][0], p.lng), Math.max(a[1][1], p.lat)]],
        [[list[0].lng, list[0].lat], [list[0].lng, list[0].lat]]);
      this.d.map.map?.fitBounds?.(b, { padding: { top: 140, bottom: Math.round((this.root.clientHeight || innerHeight) * 0.5), left: 40, right: 40 }, maxZoom: 16, duration: 500 });
    }
    this._applySnap('half');
  }

  async _renderResults() {
    this.view = 'results';
    const list = this.results;
    this._head(this.title || 'Results', `${list.length} place${list.length === 1 ? '' : 's'}`);
    this.body.textContent = '';
    if (!list.length) { this.body.appendChild(el('div', 'mui-empty', 'Nothing found. Try another word or area.')); return; }
    const ul = el('ul', 'mui-res');
    const rows = list.map((p, i) => {
      const li = el('li'); li.append(el('div', 'mui-pin', String(i + 1)));
      const t = el('div', 't'); const b = el('b', '', p.name); const s = el('span', 'mui-sub');
      t.append(b, s); li.appendChild(t);
      li.onclick = () => this.showPlace(p);
      ul.appendChild(li);
      return { p, s };
    });
    this.body.appendChild(ul);
    for (const { p, s } of rows) {
      const st = await openState(p);
      if (this.results !== list) return; // superseded
      this._meta(s, p, st);
    }
  }

  _distText(p) {
    const ref = this.me;
    const d = ref ? haversine(ref, p) : p.distanceM;
    if (d == null) return '';
    return `${fmtDist(d)} · ${Math.max(1, Math.round(d * 1.3 / WALK_MPS / 60))} min walk`;
  }

  _meta(node, p, st) {
    node.textContent = '';
    const parts = [catLabel(p.cat)];
    const dt = this._distText(p); if (dt) parts.push(dt);
    node.append(document.createTextNode(parts.join(' · ')));
    if (st != null) {
      node.append(document.createTextNode(' · '));
      node.append(el('span', st ? 'mui-open' : 'mui-closed', st ? 'Open' : 'Closed'));
    }
  }

  // ---------- place card ----------
  async showPlace(place) {
    if (this.view !== 'place') this._push();
    this.place = place;
    this.d.map.flyTo(place.lng, place.lat, 16);
    await this._renderPlace(place);
    this._applySnap('half');
  }

  async _renderPlace(place) {
    this.view = 'place'; this.place = place;
    this._head(place.name, '');
    const sub = this.grip.children[2];
    this.body.textContent = '';
    const meta = el('div', 'mui-sub');
    this.body.appendChild(meta);
    const tags = place.tags || {};
    if (tags.addr) this.body.appendChild(el('div', 'mui-sub', tags.addr));
    if (tags.cuisine) this.body.appendChild(el('div', 'mui-sub', 'Cuisine: ' + String(tags.cuisine).replace(/;/g, ', ')));
    if (tags.opening_hours) this.body.appendChild(el('div', 'mui-sub', 'Hours: ' + tags.opening_hours));
    const acts = el('div', 'mui-acts');
    acts.append(btn('Directions', 'pri', () => this.directionsTo(place)),
      btn('Add to plan', '', () => this.addToPlan(place)));
    if (tags.website) {
      const a = el('a', 'mui-btn', 'Website'); a.href = /^https?:/.test(tags.website) ? tags.website : 'https://' + tags.website;
      a.target = '_blank'; a.rel = 'noopener'; a.style.textDecoration = 'none';
      acts.appendChild(a);
    }
    this.body.prepend(acts);
    const st = await openState(place);
    if (this.place !== place) return;
    this._meta(meta, place, st);
    sub.textContent = '';
    sub.append(document.createTextNode([catLabel(place.cat), this._distText(place)].filter(Boolean).join(' · ')));
    if (st != null) { sub.append(document.createTextNode(' · ')); sub.append(el('span', st ? 'mui-open' : 'mui-closed', st ? 'Open now' : 'Closed')); }
    meta.remove();
  }

  _pin(lng, lat) {
    const place = { id: `pin:${lng.toFixed(5)},${lat.toFixed(5)}`, name: 'Dropped pin', cat: null, lng, lat, tags: {} };
    this.d.map.setResults?.([place], () => {});
    this.showPlace(place);
  }

  // ---------- directions ----------
  async directionsTo(place, { from = null } = {}) {
    if (this.view !== 'directions') this._push();
    this.view = 'directions'; this.to = place; this.place = place;
    this._endNav();
    let f = from;
    if (!f) { f = await this.d.Navigator.here(); if (f) { f = { ...f, label: 'My location' }; this.me = this.me || f; } }
    this.from = f;
    this._head(`To ${place.name}`, 'Finding route…');
    this.body.textContent = '';
    this._applySnap('half');
    await this._computeRoute();
  }

  async _computeRoute() {
    const place = this.to;
    if (!this.from) { this._renderDirections(null); return; }
    let rt = null;
    try { rt = await this.d.route([{ lng: this.from.lng, lat: this.from.lat, label: this.from.label }, { lng: place.lng, lat: place.lat, label: place.name }], { online: this.online }); }
    catch (e) { console.warn('maps-ui: route failed', e); }
    if (this.to !== place) return;
    this.rt = rt;
    if (rt) this.d.map.drawRoute(rt);
    this._renderDirections(rt);
  }

  _renderDirections(rt) {
    this.view = 'directions';
    const place = this.to;
    this.body.textContent = '';
    const ft = el('div', 'mui-ft');
    const mk = (lab, val, ro, onEnter) => {
      const l = el('label'); l.append(el('span', '', lab));
      const i = el('input'); i.value = val; i.readOnly = ro; i.placeholder = 'Choose start (area or place)'; i.setAttribute('aria-label', lab);
      if (onEnter) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(i.value); } });
      l.appendChild(i); return l;
    };
    ft.append(mk('From', this.from?.label || '', false, async (txt) => {
      const g = await this.d.places.geocode(txt, { online: this.online });
      if (!g) return this._toast('Start not found');
      this.from = g; this._head(`To ${place.name}`, 'Finding route…'); await this._computeRoute();
    }), mk('To', place.name, true));
    this.body.appendChild(ft);
    if (!rt) {
      this._head(`To ${place.name}`, this.from ? 'No route found' : 'Pick a start point');
      this.body.appendChild(el('div', 'mui-empty', this.from ? 'Could not compute a route.' : 'Location unavailable. Type a start above and press Enter.'));
      return;
    }
    this._head(`${fmtMin(rt.durationS)} · ${fmtDist(rt.distanceM)}`, '');
    const sub = this.grip.children[2];
    sub.textContent = 'Walking ';
    sub.append(el('span', 'mui-badge ' + (rt.online ? 'on' : 'off'), rt.online ? 'Online route' : 'Offline route'));
    const acts = el('div', 'mui-acts');
    acts.append(btn('Start', 'pri', () => this.startNav()), btn('Add to plan', '', () => this.addToPlan(place)));
    this.body.appendChild(acts);
    const ol = el('ol', 'mui-steps'); ol.id = 'mui-steps';
    (rt.steps || []).forEach((s, i) => { const li = el('li', '', s.text); li.dataset.i = i; li.onclick = () => this.d.map.flyTo(s.lng, s.lat, 17); ol.appendChild(li); });
    this.body.appendChild(ol);
  }

  // ---------- navigation ----------
  startNav() {
    const rt = this.rt;
    if (!rt) return;
    this._endNav();
    this.navigating = true; this.lastStep = -1;
    this.top.classList.add('hidden'); this.banner.classList.remove('hidden');
    this.nav = new this.d.Navigator({ onUpdate: u => this._onNav(u) });
    this.nav.start(rt);
    this.d.map.follow?.(true); this._markFollow(true);
    this._head('Navigating', `${fmtMin(rt.durationS)} · ${fmtDist(rt.distanceM)}`);
    this.body.textContent = '';
    const acts = el('div', 'mui-acts'); acts.append(btn('End navigation', 'bad', () => this._endNav(true)));
    this.body.append(acts);
    const ol = el('ol', 'mui-steps');
    (rt.steps || []).forEach((s, i) => { const li = el('li', '', s.text); li.dataset.i = i; ol.appendChild(li); });
    this.body.appendChild(ol);
    this._applySnap('peek');
    this._banner(rt.steps?.[0]?.text || 'Head to the route', fmtMin(rt.durationS) + ' · ' + fmtDist(rt.distanceM));
  }

  _banner(text, sub) { this.banner.children[0].textContent = text; this.banner.children[1].textContent = sub; }

  async _onNav(u) {
    this.d.map.showUser?.(u.lng, u.lat);
    this.me = { lng: u.lng, lat: u.lat };
    const rem = u.remainingM ?? 0;
    this._banner(u.step?.text || '', `${fmtMin(rem / WALK_MPS)} · ${fmtDist(rem)} left`);
    this._head('Navigating', `${fmtMin(rem / WALK_MPS)} · ${fmtDist(rem)} left`);
    this.body.querySelectorAll('.mui-steps li').forEach(li => li.classList.toggle('cur', +li.dataset.i === u.stepIndex));
    if (u.stepIndex !== this.lastStep) { this.lastStep = u.stepIndex; if (u.step?.text) this.d.speak?.(u.step.text); }
    if (u.arrived) {
      const dest = this.to;
      this._endNav();
      let inPlan = false;
      try { const ap = await this.d.plans.active(); inPlan = !!ap?.stops?.some(s => dest && String(s.place.id) === String(dest.id)); } catch {}
      this.d.speak?.(inPlan ? "You've arrived. Next plan stop?" : "You've arrived.");
      this._toast(inPlan ? "You've arrived. Next plan stop?" : "You've arrived.");
      if (inPlan) { this.d.openPlans?.('active'); }
      this._head(`Arrived at ${dest?.name || ''}`, '');
    }
  }

  _endNav(restore = false) {
    if (this.nav) { try { this.nav.stop(); } catch {} this.nav = null; }
    const was = this.navigating;
    this.navigating = false;
    this.banner.classList.add('hidden'); this.top.classList.remove('hidden');
    this.d.map.follow?.(false); this._markFollow(false);
    this.fabRecenter.classList.add('hidden');
    if (was && restore && this.rt) this._renderDirections(this.rt), this._applySnap('half');
  }

  // ---------- plan ----------
  async _togglePlanLayer() {
    this.planLayer = !this.planLayer;
    this.fabPlan.classList.toggle('on', this.planLayer);
    if (!this.planLayer) return this.d.map.clearPlan?.();
    const p = await this.d.plans.active();
    if (!p) { this.planLayer = false; this.fabPlan.classList.remove('on'); return this._toast('No active plan'); }
    this.d.map.drawPlan(p);
  }

  async addToPlan(place) {
    try {
      let plan = await this.d.plans.active() || (await this.d.plans.list()).find(p => p.status === 'draft');
      if (!plan) {
        const start = this.me ? { ...this.me, label: 'My location' } : { lng: place.lng, lat: place.lat, label: place.name };
        plan = { id: (globalThis.crypto?.randomUUID?.() || 'p' + Date.now().toString(36)), title: 'My plan', kind: 'day', created: new Date().toISOString(),
          start, startTime: new Date().toISOString(), stops: [], legs: [], status: 'draft', current: 0 };
      }
      if (plan.stops.some(s => String(s.place.id) === String(place.id))) return this._toast('Already in your plan');
      const next = await this.d.planner.addStop(plan, place, plan.stops.length, this.deps);
      await this.d.plans.save(next);
      if (this.planLayer) this.d.map.drawPlan(next);
      this._toast(`Added to ${next.title || 'plan'} (${next.stops.length} stops)`);
      return next;
    } catch (e) {
      console.warn('maps-ui: addToPlan failed', e);
      this._toast('Could not add to plan');
    }
  }
}
