// Deterministic day/night planner. No LLM. places/route/online arrive via deps.
const OH = 'https://cdn.jsdelivr.net/npm/opening_hours@3.15.0/+esm';

const STAY = { bar: 60, pub: 60, club: 120, biergarten: 75, cafe: 45, restaurant: 75, sight: 40, museum: 90, park: 40 };
const DAY = [['cafe'], ['sight', 'museum'], ['restaurant'], ['park', 'biergarten']];
const NIGHT = [['restaurant'], ['bar'], ['pub', 'bar'], ['club']];
const WALK_MPS = 4.8 / 3.6;

let ohP = null;
const loadOH = () => (ohP ??= import(OH).then(m => m.default || m.opening_hours || m).catch(() => null));

const haversine = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// true = open, false = closed, null = unknown (no/invalid hours or lib unavailable)
async function isOpen(place, when) {
  const spec = place?.tags?.opening_hours;
  if (!spec) return null;
  const OHc = await loadOH();
  if (!OHc) return null;
  try {
    const o = new OHc(spec, { lat: place.lat, lon: place.lng, address: { country_code: 'de', state: 'Berlin' } });
    return !!o.getState(when);
  } catch { return null; }
}

const addS = (d, s) => new Date(d.getTime() + s * 1000);
const stayMin = cat => STAY[cat] ?? 45;

function areaName(label) {
  const first = String(label || '').split(',')[0].trim();
  return first && first.toLowerCase() !== 'my location' ? first : 'Berlin';
}
function titleFor(kind, label) { return `${kind === 'night' ? 'Night out' : 'Day in'} · ${areaName(label)}`; }

function slots(kind, stops, cats) {
  const base = cats?.length ? cats.map(c => (Array.isArray(c) ? c : [c])) : (kind === 'night' ? NIGHT : DAY);
  return Array.from({ length: stops }, (_, i) => base[i % base.length]);
}

function uid() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function buildPlan({ kind, start, startTime, stops = 4, cats, vibe = '' }, { places, route, online }) {
  const used = new Set();
  const outStops = [], legs = [];
  let cur = { lng: start.lng, lat: start.lat };
  let t = new Date(startTime);

  for (const alts of slots(kind, stops, cats)) {
    let pick = null;
    for (const radiusM of [1500, 3000]) {
      const found = await places.search({ cats: alts, near: cur, radiusM, query: vibe, limit: 30, online });
      const cands = (found || []).filter(p => !used.has(p.id))
        .map(p => ({ p, d: haversine(cur, p) })).sort((a, b) => a.d - b.d);
      if (!cands.length) continue;
      for (const { p, d } of cands) {
        const arrival = addS(t, (d * 1.3) / WALK_MPS);
        if ((await isOpen(p, arrival)) !== false) { pick = p; break; }
      }
      pick = pick || cands[0].p; // everything closed: nearest anyway
      break;
    }
    if (!pick) continue;
    used.add(pick.id);
    const leg = await route([cur, { lng: pick.lng, lat: pick.lat }], { online });
    legs.push(leg);
    const arrive = addS(t, leg.durationS);
    const leave = new Date(arrive.getTime() + stayMin(pick.cat) * 60000);
    outStops.push({ place: pick, arrive: arrive.toISOString(), leave: leave.toISOString(), done: false });
    cur = { lng: pick.lng, lat: pick.lat };
    t = leave;
  }

  return {
    id: uid(), title: titleFor(kind, start.label), kind, created: new Date().toISOString(),
    start, startTime: new Date(startTime).toISOString(), // startTime: extra field, used to recompute after edits
    stops: outStops, legs, status: 'draft', current: 0,
  };
}

// Recompute legs + times for an edited stop list.
async function recompute(plan, stops, { route, online }) {
  const base = new Date(plan.startTime || stops[0]?.arrive || Date.now());
  let cur = { lng: plan.start.lng, lat: plan.start.lat };
  let t = base;
  const outStops = [], legs = [];
  for (const s of stops) {
    const leg = await route([cur, { lng: s.place.lng, lat: s.place.lat }], { online });
    legs.push(leg);
    const arrive = addS(t, leg.durationS);
    const leave = new Date(arrive.getTime() + stayMin(s.place.cat) * 60000);
    outStops.push({ ...s, arrive: arrive.toISOString(), leave: leave.toISOString() });
    cur = { lng: s.place.lng, lat: s.place.lat };
    t = leave;
  }
  return { ...plan, stops: outStops, legs, current: Math.min(plan.current || 0, Math.max(0, outStops.length - 1)) };
}

export async function replaceStop(plan, index, place, deps) {
  const stops = plan.stops.map((s, i) => (i === index ? { place, arrive: s.arrive, leave: s.leave, done: false } : s));
  return recompute(plan, stops, deps);
}
export async function removeStop(plan, index, deps) {
  return recompute(plan, plan.stops.filter((_, i) => i !== index), deps);
}
export async function moveStop(plan, from, to, deps) {
  const stops = plan.stops.slice();
  const [s] = stops.splice(from, 1);
  stops.splice(to, 0, s);
  return recompute(plan, stops, deps);
}
export async function addStop(plan, place, index = plan.stops.length, deps) {
  const stops = plan.stops.slice();
  const i = Math.max(0, Math.min(index ?? stops.length, stops.length));
  stops.splice(i, 0, { place, arrive: '', leave: '', done: false });
  return recompute(plan, stops, deps);
}
