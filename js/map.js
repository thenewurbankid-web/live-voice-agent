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

  hide() {
    this.el.style.display = 'none';
  }
}
