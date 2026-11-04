// Offline Berlin map: MapLibre GL + PMTiles (Blob in Cache API) + Protomaps basemap style.
const MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.7.2'; // pin: 5.7.2 (npm view maplibre-gl@5.7.2)
const PMTILES = 'https://cdn.jsdelivr.net/npm/pmtiles@4.5.0/+esm';
const BASEMAPS = 'https://cdn.jsdelivr.net/npm/@protomaps/basemaps@5.7.2/+esm';
const GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const SPRITE = 'https://protomaps.github.io/basemaps-assets/sprites/v4/light';
const CACHE = 'berlin-map-v1';
const URL_PM = new URL('../data/berlin.pmtiles', import.meta.url).href;
const KEY = 'berlin.pmtiles';
const CENTER = [13.405, 52.52];

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = `${MAPLIBRE}/dist/maplibre-gl.css`;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${MAPLIBRE}/dist/maplibre-gl.js`;
    s.onload = () => resolve(window.maplibregl);
    s.onerror = () => reject(new Error('maplibre-gl failed to load'));
    document.head.appendChild(s);
  });
}

export class BerlinMap {
  constructor(containerEl) {
    this.el = containerEl;
    this.map = null;
    this.blob = null;
  }

  async ensureOffline(onProgress = () => {}) {
    const cache = await caches.open(CACHE);
    let hit = await cache.match(KEY);
    if (!hit) {
      const res = await fetch(URL_PM);
      if (!res.ok) throw new Error(`map download failed: ${res.status}`);
      const total = +res.headers.get('content-length') || 0;
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        onProgress(total ? Math.min(got / total, 1) : 0, 'Downloading Berlin map');
      }
      const blob = new Blob(parts, { type: 'application/octet-stream' });
      await cache.put(KEY, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } }));
      hit = await cache.match(KEY);
    }
    this.blob = await hit.blob();
    onProgress(1, 'Berlin map ready');
  }

  async show() {
    if (this.map) { this.el.style.display = ''; this.map.resize(); return; }
    if (!this.blob) await this.ensureOffline();
    const [maplibregl, { Protocol, PMTiles, FileSource }, bm] = await Promise.all([
      loadMapLibre(), import(PMTILES), import(BASEMAPS),
    ]);
    const protocol = new Protocol();
    protocol.add(new PMTiles(new FileSource(new File([this.blob], KEY))));
    maplibregl.addProtocol('pmtiles', protocol.tilev4);

    // Glyphs/sprites live online only; offline we drop label/icon layers so the map still renders.
    let online = navigator.onLine;
    if (online) {
      try {
        const r = await fetch(GLYPHS.replace('{fontstack}', 'Noto Sans Regular').replace('{range}', '0-255'), { signal: AbortSignal.timeout(3000) });
        online = r.ok;
      } catch { online = false; }
    }
    const layers = bm.layers('protomaps', bm.namedFlavor('light'), { lang: 'en' })
      .filter(l => online || l.type !== 'symbol');
    const style = {
      version: 8,
      sources: { protomaps: { type: 'vector', url: `pmtiles://${KEY}`, attribution: '© OpenStreetMap, Protomaps' } },
      layers,
    };
    if (online) { style.glyphs = GLYPHS; style.sprite = SPRITE; }
    this.el.style.display = '';
    this.map = new maplibregl.Map({
      container: this.el, style, center: CENTER, zoom: 11, maxZoom: 15.99,
      maxBounds: [[12.9, 52.25], [13.9, 52.76]],
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    await new Promise(r => this.map.once('load', r));
  }

  flyTo(lng, lat, zoom = 15) {
    this.map?.flyTo({ center: [lng, lat], zoom, essential: true });
  }

  // ---- Phase 2: plan overlay (route lines, numbered markers, user dot) ----
  _fc(features) { return { type: 'FeatureCollection', features }; }

  _ensurePlanLayers() {
    const m = this.map;
    if (!m || m.getSource('plan-route')) return;
    m.addSource('plan-route', { type: 'geojson', data: this._fc([]) });
    m.addLayer({ id: 'plan-route-casing', type: 'line', source: 'plan-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 8, 'line-opacity': 0.9 } });
    m.addLayer({ id: 'plan-route-line', type: 'line', source: 'plan-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['case', ['get', 'online'], '#3b6fe0', '#8a5cf0'], 'line-width': 4,
               'line-dasharray': ['case', ['get', 'online'], ['literal', [1, 0]], ['literal', [2, 1.5]]] } });
    m.addSource('plan-user', { type: 'geojson', data: this._fc([]) });
    m.addLayer({ id: 'plan-user-halo', type: 'circle', source: 'plan-user', paint: { 'circle-radius': 14, 'circle-color': '#38d39f', 'circle-opacity': 0.25 } });
    m.addLayer({ id: 'plan-user-dot', type: 'circle', source: 'plan-user',
      paint: { 'circle-radius': 6, 'circle-color': '#38d39f', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }

  drawPlan(plan) {
    if (!this.map || !plan) return;
    const gl = window.maplibregl;
    this._ensurePlanLayers();
    this.map.getSource('plan-route').setData(this._fc(
      (plan.legs || []).filter(l => l && l.line).map(l => ({ type: 'Feature', properties: { online: !!l.online }, geometry: l.line }))));
    (this._planMarkers || []).forEach(mk => mk.remove());
    this._planMarkers = [];
    const pts = [];
    const add = (lng, lat, label, bg) => {
      const el = document.createElement('div');
      el.textContent = label;
      el.style.cssText = `width:26px;height:26px;border-radius:50%;background:${bg};color:#fff;font:700 13px/26px system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)`;
      this._planMarkers.push(new gl.Marker({ element: el }).setLngLat([lng, lat]).addTo(this.map));
      pts.push([lng, lat]);
    };
    if (plan.start) add(plan.start.lng, plan.start.lat, 'S', '#555');
    (plan.stops || []).forEach((st, i) => {
      const cur = plan.status === 'active' && i === plan.current;
      add(st.place.lng, st.place.lat, String(i + 1), st.done ? '#38d39f' : cur ? '#ff9f43' : '#3b6fe0');
    });
    (plan.legs || []).forEach(l => (l?.line?.coordinates || []).forEach(c => pts.push(c)));
    if (pts.length) {
      const b = pts.reduce((a, c) => [[Math.min(a[0][0], c[0]), Math.min(a[0][1], c[1])], [Math.max(a[1][0], c[0]), Math.max(a[1][1], c[1])]],
        [[pts[0][0], pts[0][1]], [pts[0][0], pts[0][1]]]);
      this.map.fitBounds(b, { padding: 50, maxZoom: 16, duration: 600 });
    }
  }

  showUser(lng, lat) {
    if (!this.map) return;
    this._ensurePlanLayers();
    this.map.getSource('plan-user').setData(this._fc([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] } }]));
  }

  clearPlan() {
    (this._planMarkers || []).forEach(mk => mk.remove());
    this._planMarkers = [];
    if (!this.map || !this.map.getSource('plan-route')) return;
    this.map.getSource('plan-route').setData(this._fc([]));
    this.map.getSource('plan-user').setData(this._fc([]));
  }

  hide() {
    this.el.style.display = 'none';
  }
}
