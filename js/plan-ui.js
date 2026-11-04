// Plan sheet: New / Active / History. All collaborators are injected (see CONTRACTS.md).
const CSS = `
.pui{position:fixed;inset:auto 0 0 0;max-height:78dvh;background:var(--panel);border-radius:20px 20px 0 0;border-top:1px solid var(--line);padding:10px 14px calc(14px + var(--safe-b,0px));overflow:auto;z-index:6;display:flex;flex-direction:column;gap:10px;color:var(--ink)}
.pui.hidden{display:none!important}
@media (min-width:900px){.pui{left:auto;right:16px;bottom:16px;width:420px;border-radius:20px;border:1px solid var(--line)}}
.pui button{font:inherit;color:inherit;cursor:pointer}
.pui .p-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.pui .p-tabs{display:flex;gap:6px;flex:1}
.pui .p-tab{flex:1;padding:8px 6px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--mute)}
.pui .p-tab.on{background:var(--accent);color:#0b0d12;border-color:var(--accent);font-weight:600}
.pui .p-x{background:none;border:0;color:var(--mute);padding:8px}
.pui .p-body{display:flex;flex-direction:column;gap:10px}
.pui label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--mute)}
.pui input,.pui select{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--ink);min-height:42px}
.pui .p-row{display:flex;gap:8px}.pui .p-row>*{flex:1}
.pui .p-seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.pui .p-seg button{flex:1;padding:10px;background:transparent;border:0;color:var(--mute)}
.pui .p-seg button.on{background:var(--accent);color:#0b0d12;font-weight:600}
.pui .p-btn{padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);min-height:42px}
.pui .p-btn.pri{background:var(--accent);color:#0b0d12;border-color:var(--accent);font-weight:600}
.pui .p-btn.bad{color:var(--bad)}
.pui .p-btn.sm{padding:4px 9px;min-height:30px;font-size:13px;border-radius:9px}
.pui .p-btns{display:flex;gap:8px;flex-wrap:wrap}
.pui .p-btns .p-btn{flex:1}
.pui .p-bar{height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.pui .p-bar>i{display:block;height:100%;background:var(--ok);transition:width .3s}
.pui .p-meta{display:flex;justify-content:space-between;font-size:13px;color:var(--mute)}
.pui .p-title{font-weight:600;font-size:16px}
.pui ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pui li.stop{border:1px solid var(--line);border-radius:12px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.pui li.stop.cur{border-color:var(--accent);background:rgba(122,162,255,.1)}
.pui li.stop.done{opacity:.55}
.pui .p-s{display:flex;gap:10px;align-items:center}
.pui .p-n{width:24px;height:24px;border-radius:50%;background:var(--line);display:grid;place-items:center;font-size:12px;font-weight:700;flex:none}
.pui li.cur .p-n{background:var(--accent);color:#0b0d12}.pui li.done .p-n{background:var(--ok);color:#0b0d12}
.pui .p-t{flex:1;min-width:0}.pui .p-t b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pui .p-t small{color:var(--mute)}
.pui .p-acts{display:flex;gap:6px;flex-wrap:wrap}
.pui .p-nav{border:1px solid var(--accent);border-radius:12px;padding:8px 10px;font-size:14px}
.pui .p-pick{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--line);padding-top:6px}
.pui .p-pick button{text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px}
.pui .p-empty{color:var(--mute);text-align:center;padding:18px 0}
.pui .p-err{color:var(--bad);font-size:13px}
`;

const fmtT = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtD = iso => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + fmtT(iso);
const mins = leg => (leg && leg.durationS ? Math.max(1, Math.round(leg.durationS / 60)) : 0);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = el('button', 'p-btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; return b; };

export class PlanUI {
  constructor(rootEl, deps) {
    this.root = rootEl;
    this.d = deps;
    this.view = 'active';
    this.plan = null;
    this.nav = null;
    this.navInfo = null;
    this.lastStep = -1;
    this.swapIdx = -1;
    this.swapList = [];
    this.form = { kind: 'day', startText: '', time: '', stops: 4 };
    this.err = '';
    this.busy = false;
    if (!document.getElementById('plan-ui-css')) {
      const s = document.createElement('style'); s.id = 'plan-ui-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    this.root.classList.add('pui', 'hidden');
  }

  get deps() { return { places: this.d.places, route: this.d.route, online: !!this.d.getOnline() }; }

  async open(view = 'active') {
    this.root.classList.remove('hidden');
    this.view = view;
    if (view === 'active' && !this.plan) this.plan = await this.d.store.active();
    if (view === 'active' && this.plan) this.d.map.drawPlan?.(this.plan);
    await this.render();
  }

  close() {
    this.stopNav();
    this.root.classList.add('hidden');
  }

  async showPlan(plan) {
    this.plan = plan;
    this.view = 'active';
    this.swapIdx = -1;
    this.root.classList.remove('hidden');
    try { await this.d.map.show?.(); } catch {}
    this.d.map.drawPlan(plan);
    await this.render();
  }

  async createFromVoice({ kind = 'night', startText = '', stops = 4 } = {}) {
    let start = null;
    const online = !!this.d.getOnline();
    if (startText && !/^(my location|here|me)$/i.test(startText.trim())) {
      try { start = await this.d.places.geocode(startText, { online }); } catch {}
    }
    if (!start) {
      const h = await this.d.Navigator.here();
      start = h ? { ...h, label: 'My location' } : null;
    }
    if (!start) throw new Error('Could not find a start point');
    const plan = await this.d.buildPlan({ kind, start, startTime: new Date(), stops }, this.deps);
    await this.d.store.save(plan);
    await this.showPlan(plan);
    return plan;
  }

  async save() { if (this.plan) await this.d.store.save(this.plan); }

  stopNav() { try { this.nav?.stop(); } catch {} this.nav = null; this.navInfo = null; this.lastStep = -1; }

  // ---------- rendering ----------
  async render() {
    const r = this.root;
    r.replaceChildren();
    const head = el('div', 'p-head');
    const tabs = el('div', 'p-tabs');
    for (const [k, l] of [['new', 'New'], ['active', 'Active'], ['history', 'History']]) {
      const t = el('button', 'p-tab' + (this.view === k ? ' on' : ''), l); t.type = 'button';
      t.onclick = () => this.open(k);
      tabs.appendChild(t);
    }
    const x = el('button', 'p-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.onclick = () => this.close();
    head.append(tabs, x);
    const body = el('div', 'p-body');
    r.append(head, body);
    if (this.err) body.appendChild(el('div', 'p-err', this.err));
    if (this.view === 'new') this.renderNew(body);
    else if (this.view === 'history') await this.renderHistory(body);
    else this.renderActive(body);
  }

  renderNew(b) {
    const f = this.form;
    const seg = el('div', 'p-seg');
    for (const k of ['day', 'night']) {
      const s = el('button', f.kind === k ? 'on' : '', k === 'day' ? 'Day in' : 'Night out'); s.type = 'button';
      s.onclick = () => { f.kind = k; this.render(); };
      seg.appendChild(s);
    }
    const start = el('input'); start.placeholder = 'My location'; start.value = f.startText;
    start.oninput = () => { f.startText = start.value; };
    const time = el('input'); time.type = 'time'; time.value = f.time || this.defaultTime(f.kind);
    time.onchange = () => { f.time = time.value; };
    const n = el('select');
    for (let i = 2; i <= 8; i++) { const o = el('option', '', i + ' stops'); o.value = i; if (i === f.stops) o.selected = true; n.appendChild(o); }
    n.onchange = () => { f.stops = +n.value; };
    const lab = (t, c) => { const l = el('label', '', t); l.appendChild(c); return l; };
    const row = el('div', 'p-row'); row.append(lab('Start time', time), lab('Stops', n));
    const go = btn(this.busy ? 'Building…' : 'Build plan', 'pri', async () => {
      if (this.busy) return;
      this.busy = true; this.err = ''; await this.render();
      try {
        const [hh, mm] = (f.time || time.value || this.defaultTime(f.kind)).split(':').map(Number);
        const st = new Date(); st.setHours(hh, mm, 0, 0);
        if (st < Date.now() - 3600e3) st.setDate(st.getDate() + 1);
        let startPt = null;
        if (f.startText.trim()) startPt = await this.d.places.geocode(f.startText, { online: !!this.d.getOnline() });
        if (f.startText.trim() && !startPt) throw new Error(`Could not find "${f.startText}"`);
        if (!startPt) { const h = await this.d.Navigator.here(); if (!h) throw new Error('No location — type a start place'); startPt = { ...h, label: 'My location' }; }
        const plan = await this.d.buildPlan({ kind: f.kind, start: startPt, startTime: st, stops: f.stops }, this.deps);
        await this.d.store.save(plan);
        this.busy = false;
        await this.showPlan(plan);
      } catch (e) { this.busy = false; this.err = e.message || String(e); await this.render(); }
    });
    b.append(seg, lab('Start (blank = my location)', start), row, go);
  }

  defaultTime(kind) { return kind === 'night' ? '20:00' : '10:00'; }

  renderActive(b) {
    const p = this.plan;
    if (!p) { b.appendChild(el('div', 'p-empty', 'No active plan. Build one in New, or open one from History.')); return; }
    const total = p.stops.length, done = p.stops.filter(s => s.done).length;
    const last = p.stops[total - 1];
    b.appendChild(el('div', 'p-title', p.title));
    const bar = el('div', 'p-bar'); const fill = el('i'); fill.style.width = (total ? done / total * 100 : 0) + '%'; bar.appendChild(fill);
    const eta = last ? `Ends ${fmtT(last.leave)}` + (p.status === 'active' ? ` · ${Math.max(0, Math.round((new Date(last.leave) - Date.now()) / 60000))} min left` : '') : '';
    const meta = el('div', 'p-meta'); meta.append(el('span', '', `${done}/${total} done`), el('span', '', eta));
    b.append(bar, meta);

    const ol = el('ol');
    p.stops.forEach((s, i) => {
      const cur = p.status === 'active' && i === p.current && !s.done;
      const li = el('li', 'stop' + (cur ? ' cur' : '') + (s.done ? ' done' : ''));
      const w = mins(p.legs?.[i]);
      const row = el('div', 'p-s');
      const t = el('div', 'p-t');
      t.append(el('b', '', s.place.name), el('small', '', `${fmtT(s.arrive)}–${fmtT(s.leave)} · ${s.place.cat}` + (w ? ` · ${w} min walk` : '')));
      row.append(el('span', 'p-n', s.done ? '✓' : String(i + 1)), t);
      li.appendChild(row);
      const acts = el('div', 'p-acts');
      if (i > 0) acts.appendChild(btn('▲', 'sm', () => this.mutate(() => this.d.moveStop(p, i, i - 1, this.deps))));
      if (i < total - 1) acts.appendChild(btn('▼', 'sm', () => this.mutate(() => this.d.moveStop(p, i, i + 1, this.deps))));
      acts.appendChild(btn('Swap', 'sm', () => this.openSwap(i)));
      acts.appendChild(btn('Remove', 'sm bad', () => this.mutate(() => this.d.removeStop(p, i, this.deps))));
      li.appendChild(acts);
      if (this.swapIdx === i) {
        const pick = el('div', 'p-pick');
        if (!this.swapList.length) pick.appendChild(el('small', '', 'No alternatives nearby'));
        this.swapList.forEach(pl => pick.appendChild(btn(pl.name, '', () => { this.swapIdx = -1; this.mutate(() => this.d.replaceStop(p, i, pl, this.deps)); })));
        li.appendChild(pick);
      }
      ol.appendChild(li);
    });
    b.appendChild(ol);

    if (this.navInfo) {
      const n = el('div', 'p-nav');
      n.append(el('div', '', this.navInfo.arrived ? 'You have arrived' : (this.navInfo.text || 'Walking…')),
        el('small', '', `${Math.round(this.navInfo.remainingM || 0)} m remaining`));
      b.appendChild(n);
    }
    const btns = el('div', 'p-btns');
    if (p.status !== 'active' && p.status !== 'done') btns.appendChild(btn('Start', 'pri', () => this.start()));
    if (p.status === 'active') {
      btns.appendChild(btn('Done → next', 'pri', () => this.next()));
      btns.appendChild(btn(this.nav ? 'Stop navigating' : 'Navigate', '', () => this.toggleNav()));
    }
    if (p.status === 'done') btns.appendChild(el('div', 'p-empty', 'Plan complete'));
    b.appendChild(btns);
  }

  async renderHistory(b) {
    const list = await this.d.store.list();
    if (!list.length) { b.appendChild(el('div', 'p-empty', 'No plans yet.')); return; }
    const ol = el('ol');
    for (const p of list) {
      const li = el('li', 'stop');
      const t = el('div', 'p-t');
      t.append(el('b', '', p.title), el('small', '', `${fmtD(p.created)} · ${p.kind} · ${p.stops.length} stops · ${p.status}`));
      const acts = el('div', 'p-acts');
      acts.append(
        btn('Open', 'sm', () => this.showPlan(p)),
        btn('Duplicate', 'sm', async () => {
          const c = JSON.parse(JSON.stringify(p));
          c.id = (crypto.randomUUID?.() || String(Date.now())); c.created = new Date().toISOString();
          c.status = 'draft'; c.current = 0; c.stops.forEach(s => { s.done = false; });
          c.title = p.title.replace(/ \(copy\)$/, '') + ' (copy)';
          await this.d.store.save(c); this.render();
        }),
        btn('Delete', 'sm bad', async () => {
          await this.d.store.remove(p.id);
          if (this.plan?.id === p.id) { this.plan = null; this.stopNav(); this.d.map.clearPlan(); }
          this.render();
        }));
      li.append(t, acts);
      ol.appendChild(li);
    }
    b.appendChild(ol);
  }

  // ---------- actions ----------
  async mutate(fn) {
    try {
      this.plan = await fn();
      this.err = '';
      await this.save();
      this.swapIdx = -1;
      this.d.map.drawPlan(this.plan);
    } catch (e) { this.err = e.message || String(e); }
    await this.render();
  }

  async openSwap(i) {
    if (this.swapIdx === i) { this.swapIdx = -1; return this.render(); }
    const s = this.plan.stops[i].place;
    this.swapIdx = i; this.swapList = [];
    await this.render();
    try {
      const used = new Set(this.plan.stops.map(x => x.place.id));
      const res = await this.d.places.search({ cats: [s.cat], near: { lng: s.lng, lat: s.lat }, radiusM: 1500, limit: 8, online: !!this.d.getOnline() });
      this.swapList = res.filter(r => !used.has(r.id)).slice(0, 6);
    } catch (e) { this.err = e.message || String(e); }
    await this.render();
  }

  async start() {
    const p = this.plan;
    p.status = 'active';
    const k = p.stops.findIndex(s => !s.done);
    p.current = k < 0 ? 0 : k;
    await this.save();
    this.d.map.drawPlan(p);
    const s = p.stops[p.current];
    if (s) this.d.speak(`Starting ${p.title}. First stop: ${s.place.name}.`);
    await this.render();
  }

  async next() {
    const p = this.plan;
    this.stopNav();
    if (p.stops[p.current]) p.stops[p.current].done = true;
    const k = p.stops.findIndex(s => !s.done);
    if (k < 0) { p.status = 'done'; p.current = p.stops.length; this.d.speak('That was the last stop. Plan complete.'); }
    else { p.current = k; this.d.speak(`Next: ${p.stops[k].place.name}.`); }
    await this.save();
    this.d.map.drawPlan(p);
    await this.render();
  }

  async toggleNav() {
    if (this.nav) { this.stopNav(); return this.render(); }
    const p = this.plan, leg = p.legs?.[p.current];
    if (!leg) { this.err = 'No route for this stop'; return this.render(); }
    this.nav = new this.d.Navigator({
      onUpdate: ({ lng, lat, stepIndex, step, remainingM, arrived }) => {
        if (lng != null) this.d.map.showUser(lng, lat);
        this.navInfo = { text: step?.text, remainingM, arrived };
        if (stepIndex !== this.lastStep && step?.text) { this.lastStep = stepIndex; this.d.speak(step.text); }
        if (arrived) { this.d.speak(`You have arrived at ${p.stops[p.current]?.place.name || 'the stop'}.`); this.nav?.stop(); this.nav = null; }
        if (this.view === 'active' && !this.root.classList.contains('hidden')) this.render();
      },
    });
    this.lastStep = -1;
    this.nav.start(leg);
    await this.render();
  }
}
