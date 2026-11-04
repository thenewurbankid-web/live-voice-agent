// Live turn-by-turn on a Route using the Geolocation API.
import { loadGeo } from './routing.js';

const ARRIVED_M = 30;

export class Navigator {
  constructor({ onUpdate } = {}) { this.onUpdate = onUpdate || (() => {}); this.watch = null; this.route = null; }

  start(route) {
    this.stop();
    this.route = route;
    this.watch = navigator.geolocation.watchPosition((pos) => this._fix(pos).catch(() => {}), () => {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }

  stop() {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }

  async _fix(pos) {
    const r = this.route; if (!r || this.watch == null) return;
    const g = await loadGeo(), me = { lng: pos.coords.longitude, lat: pos.coords.latitude };
    const c = r.line.coordinates.map(([lng, lat]) => ({ lng, lat }));
    let best = 0, bd = Infinity;
    c.forEach((p, i) => { const d = g.dist(me, p); if (d < bd) { bd = d; best = i; } });
    let rem = g.dist(me, c[best]);
    for (let i = best; i < c.length - 1; i++) rem += g.dist(c[i], c[i + 1]);
    // current step = last step whose start point is not beyond the nearest line vertex
    let stepIndex = 0, sb = Infinity;
    r.steps.forEach((s, i) => { const d = g.dist(me, s); if (d < sb) { sb = d; stepIndex = i; } });
    const end = c[c.length - 1], arrived = g.dist(me, end) < ARRIVED_M;
    if (arrived) stepIndex = r.steps.length - 1;
    else if (stepIndex < r.steps.length - 1 && sb < 25) stepIndex += 1; // passed this maneuver → announce the next
    this.onUpdate({ lng: me.lng, lat: me.lat, stepIndex, step: r.steps[stepIndex], remainingM: rem, arrived });
  }

  static here() {
    return new Promise((resolve) => {
      if (!globalThis.navigator?.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude }), () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000 });
    });
  }
}
