// Pure routing core for data/berlin-walk.bin (layout documented in tools/build-walk-graph.py). No DOM, no CDN imports:
// the worker (and the node test) inject ngraph: createRouter(buffer, { createGraph, aStar }).
const R = 6371008.8, rad = (d) => d * Math.PI / 180, WALK_MS = 4.8 / 3.6;
const MAX_SNAP_M = 1500;

export function haversine(aLng, aLat, bLng, bLat) {
  const dl = rad(bLat - aLat), dn = rad(bLng - aLng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function bearing(aLng, aLat, bLng, bLat) {
  const y = Math.sin(rad(bLng - aLng)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLng - aLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compass = (deg) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
const metres = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;

export function parseGraph(buf) {
  const u = new Uint32Array(buf, 0, 9);
  if (u[0] !== 0x31475742) throw new Error('bad berlin-walk.bin magic');
  const [, N, E, S, P] = u;
  let o = 36;
  const nodes = new Int32Array(buf, o, N * 2); o += N * 8;
  const eo = o; o += E * 24;
  const edgeU = new Uint32Array(buf, eo, E * 6), edgeF = new Float32Array(buf, eo, E * 6);
  const poly = new Int32Array(buf, o, P * 2); o += P * 8;
  const nameOff = new Uint32Array(buf, o, S + 1); o += (S + 1) * 4;
  const nameBytes = new Uint8Array(buf, o);
  const dec = new TextDecoder();
  return { N, E, S, nodes, edgeU, edgeF, poly, nameOff, nameBytes,
    name: (id) => dec.decode(nameBytes.subarray(nameOff[id], nameOff[id + 1])) };
}

function gridIndex(g) {
  const CELL = 2000, cells = new Map(); // micro-degrees (~0.002 deg)
  for (let i = 0; i < g.N; i++) {
    const k = Math.floor(g.nodes[2 * i] / CELL) * 100000 + Math.floor(g.nodes[2 * i + 1] / CELL);
    (cells.get(k) || cells.set(k, []).get(k)).push(i);
  }
  return (lng, lat) => {
    const cx = Math.floor(lng * 1e6 / CELL), cy = Math.floor(lat * 1e6 / CELL);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= 8; r++) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        if (r > 0 && Math.abs(x - cx) !== r && Math.abs(y - cy) !== r) continue;
        for (const i of cells.get(x * 100000 + y) || []) {
          const d = haversine(lng, lat, g.nodes[2 * i] / 1e6, g.nodes[2 * i + 1] / 1e6);
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && bd < r * 130) break; // ring r fully covers radius ~r*0.002deg*~70km/deg lower bound
    }
    return best >= 0 && bd <= MAX_SNAP_M ? { id: best, dist: bd } : null;
  };
}

export function createRouter(buf, { createGraph, aStar }) {
  const g = parseGraph(buf), snap = gridIndex(g), graph = createGraph();
  const { nodes, edgeU, edgeF } = g;
  for (let i = 0; i < g.N; i++) graph.addNode(i, i);
  const best = new Map(); // keep the shortest of parallel edges
  for (let e = 0; e < g.E; e++) {
    const a = edgeU[e * 6], b = edgeU[e * 6 + 1];
    if (a === b) continue;
    const k = a < b ? a * 4294967296 + b : b * 4294967296 + a, o = best.get(k);
    if (o === undefined || edgeF[e * 6 + 2] < edgeF[o * 6 + 2]) best.set(k, e);
  }
  for (const e of best.values()) graph.addLink(edgeU[e * 6], edgeU[e * 6 + 1], e);
  const finder = aStar(graph, {
    distance: (f, t, link) => edgeF[link.data * 6 + 2],
    heuristic: (f, t) => haversine(nodes[2 * f.id] / 1e6, nodes[2 * f.id + 1] / 1e6, nodes[2 * t.id] / 1e6, nodes[2 * t.id + 1] / 1e6),
  });

  // → { coords:[[lng,lat]..], edges:[{nameId, from, to, start, end}] } for one leg between graph nodes
  function leg(a, b) {
    if (a === b) return { coords: [[nodes[2 * a] / 1e6, nodes[2 * a + 1] / 1e6]], runs: [] };
    const path = finder.find(a, b);
    if (!path.length) return null;
    path.reverse(); // ngraph returns target → source
    const coords = [[nodes[2 * a] / 1e6, nodes[2 * a + 1] / 1e6]], runs = [];
    for (let i = 1; i < path.length; i++) {
      const u = path[i - 1].id, v = path[i].id, link = graph.getLink(u, v) || graph.getLink(v, u), e = link.data;
      const pc = edgeU[e * 6 + 5], ps = edgeU[e * 6 + 4], fwd = edgeU[e * 6] === u, pts = [];
      for (let k = 0; k < pc; k++) { const j = fwd ? ps + k : ps + pc - 1 - k; pts.push([g.poly[2 * j] / 1e6, g.poly[2 * j + 1] / 1e6]); }
      pts.push([nodes[2 * v] / 1e6, nodes[2 * v + 1] / 1e6]);
      runs.push({ nameId: edgeU[e * 6 + 3], len: edgeF[e * 6 + 2], from: coords.length - 1, to: coords.length - 1 + pts.length });
      for (const p of pts) coords.push(p);
    }
    return { coords, runs };
  }

  function stepsFor(coords, runs, last) {
    const steps = [];
    let cur = null;
    const segB = (i) => bearing(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    const label = (id) => id ? g.name(id) : '';
    let prev = null;
    for (const r of runs) {
      const out = segB(r.from), nm = label(r.nameId);
      let turn = null;
      if (prev) {
        const d = ((out - segB(prev.to - 1) + 540) % 360) - 180;
        if (nm !== label(prev.nameId) || Math.abs(d) > 30) turn = d;
      }
      if (!cur || (turn !== null && nm !== '')) { // unnamed paths/crossings never start a step
        cur = { nm, turn, out, dist: 0, at: coords[r.from] };
        steps.push(cur);
      }
      cur.dist += r.len; prev = r;
    }
    return steps.map((s, i) => {
      const name = s.nm ? ` onto ${s.nm}` : '', then = `, then ${metres(s.dist)}`;
      let text;
      if (i === 0) text = `Head ${compass(s.out)}${s.nm ? ` on ${s.nm}` : ''}, ${metres(s.dist)}`;
      else {
        const a = Math.abs(s.turn), side = s.turn < 0 ? 'left' : 'right';
        if (a > 160) text = `Make a U-turn${then}`;
        else if (a <= 30) text = `Continue${name}${then}`;
        else text = `Turn ${a < 60 ? 'slight ' : a > 120 ? 'sharp ' : ''}${side}${name}${then}`;
      }
      return { text, distanceM: s.dist, lng: s.at[0], lat: s.at[1] };
    });
  }

  function route(points) {
    const sn = points.map((p) => snap(p.lng, p.lat));
    if (sn.some((s) => !s)) return null;
    const coords = [], steps = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const l = leg(sn[i - 1].id, sn[i].id);
      if (!l) return null;
      const lc = l.coords;
      for (const c of lc) coords.push(c);
      total += l.runs.reduce((s, r) => s + r.len, 0);
      steps.push(...stepsFor(lc, l.runs));
    }
    const a = points[0], z = points[points.length - 1];
    coords.unshift([a.lng, a.lat]); coords.push([z.lng, z.lat]);
    total += sn[0].dist + sn[sn.length - 1].dist;
    steps.push({ text: 'You have arrived', distanceM: 0, lng: z.lng, lat: z.lat });
    return { line: { type: 'LineString', coordinates: coords }, distanceM: total, durationS: total / WALK_MS, steps, online: false };
  }
  return { route, stats: { nodes: g.N, edges: best.size } };
}
