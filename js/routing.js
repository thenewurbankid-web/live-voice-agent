// Walking routes: public OSRM foot server online, offline A* on the bundled OSM graph (offline-router.js), straight-segment estimate as last resort.
// Geo math via @turf (pinned, CDN); falls back to built-in haversine if the CDN is unreachable.
const OSRM = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const TURF = '7.4.0';
const DETOUR = 1.3, WALK_MS = 4.8 / 3.6; // 4.8 km/h in m/s
const R = 6371008.8, rad = (d) => d * Math.PI / 180;

let geoP;
export function loadGeo() {
  return geoP ||= (async () => {
    try {
      const [d, b] = await Promise.all([
        import(`https://cdn.jsdelivr.net/npm/@turf/distance@${TURF}/+esm`),
        import(`https://cdn.jsdelivr.net/npm/@turf/bearing@${TURF}/+esm`),
      ]);
      return {
        dist: (a, c) => d.default([a.lng, a.lat], [c.lng, c.lat], { units: 'meters' }),
        bearing: (a, c) => b.default([a.lng, a.lat], [c.lng, c.lat]),
      };
    } catch {
      return {
        dist(a, c) {
          const dl = rad(c.lat - a.lat), dn = rad(c.lng - a.lng);
          const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(c.lat)) * Math.sin(dn / 2) ** 2;
          return 2 * R * Math.asin(Math.sqrt(h));
        },
        bearing(a, c) {
          const y = Math.sin(rad(c.lng - a.lng)) * Math.cos(rad(c.lat));
          const x = Math.cos(rad(a.lat)) * Math.sin(rad(c.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(c.lat)) * Math.cos(rad(c.lng - a.lng));
          return Math.atan2(y, x) * 180 / Math.PI;
        },
      };
    }
  })();
}

export const compass = (deg) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
export const metres = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;

function stepText(s, next) {
  const m = s.maneuver || {}, name = s.name ? ` onto ${s.name}` : '', dir = m.modifier || '';
  const then = next ? `, then ${metres(s.distance)}` : '';
  switch (m.type) {
    case 'depart': return `Head ${dir && dir !== 'straight' ? dir : 'ahead'}${s.name ? ` on ${s.name}` : ''}, ${metres(s.distance)}`;
    case 'arrive': return 'You have arrived';
    case 'roundabout': case 'rotary': return `At the roundabout take exit ${m.exit || 1}${name}${then}`;
    case 'continue': case 'new name': return `Continue${s.name ? ` on ${s.name}` : ' straight'}${then}`;
    default:
      if (dir === 'uturn') return `Make a U-turn${then}`;
      if (!dir || dir === 'straight') return `Go straight${s.name ? ` on ${s.name}` : ''}${then}`;
      return `Turn ${dir}${name}${then}`;
  }
}

async function offline(points) {
  try { const { routeOffline } = await import('./offline-router.js'); const r = await routeOffline(points); if (r) return r; } catch { /* graph unavailable → straight lines */ }
  const g = await loadGeo(), coords = points.map((p) => [p.lng, p.lat]), steps = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = g.dist(a, b) * DETOUR;
    total += d;
    steps.push({ text: `Walk ${metres(d)} ${compass(g.bearing(a, b))} to ${b.label || b.name || 'the next point'}`, distanceM: d, lng: a.lng, lat: a.lat });
  }
  const e = points[points.length - 1];
  steps.push({ text: 'You have arrived', distanceM: 0, lng: e.lng, lat: e.lat });
  return { line: { type: 'LineString', coordinates: coords }, distanceM: total, durationS: total / WALK_MS, steps, online: false };
}

export async function route(points, { online } = {}) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('route needs at least 2 points');
  if (online) {
    try {
      const path = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const res = await fetch(`${OSRM}${path}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const j = await res.json();
      const r = j.routes?.[0];
      if (j.code !== 'Ok' || !r) throw new Error('OSRM no route');
      const steps = [];
      for (const leg of r.legs) leg.steps.forEach((s, i) => {
        const [lng, lat] = s.maneuver.location;
        steps.push({ text: stepText(s, i < leg.steps.length - 1), distanceM: s.distance, lng, lat });
      });
      return { line: r.geometry, distanceM: r.distance, durationS: r.duration, steps, online: true };
    } catch { /* any online error → offline result */ }
  }
  return offline(points);
}
