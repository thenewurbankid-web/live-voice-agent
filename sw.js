// App-shell + CDN cache so the app starts with no network after the first visit.
// Model weights are cached by WebLLM / transformers.js themselves (Cache API), and the
// Berlin tiles by js/map.js, so they are deliberately not duplicated here.
const SHELL = 'live-shell-v15';
const CDN = 'live-cdn-v1';
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/brain.js', 'js/llm-worker.js', 'js/ml-worker.js', 'js/ml.js', 'js/ears.js', 'js/voice.js', 'js/eyes.js', 'js/translate.js', 'js/map.js', 'js/ocr.js', 'js/web.js', 'js/research.js', 'js/routing.js', 'js/navigator.js', 'js/places.js', 'js/planner.js', 'js/plans-store.js', 'js/plan-ui.js', 'js/memory.js', 'js/sounds.js', 'js/aware.js', 'js/graph-memory.js', 'js/maps-ui.js', 'js/offline-router.js', 'js/router-worker.js', 'js/router-core.js', 'data/berlin-pois.json',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'protomaps.github.io', 'raw.githubusercontent.com', 'storage.googleapis.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('live-') && ![SHELL, CDN].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('.pmtiles') || url.pathname.endsWith('.bin')) return; // map.js stores it itself
    // Network first for the shell so updates land, but give it only 1.5 s before the cached copy answers
    // (a slow phone connection must not hold up startup). A late network answer still refreshes the cache.
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); try { e.waitUntil(caches.open(SHELL).then((c) => c.put(req, copy))); } catch {} }
      return res;
    });
    e.waitUntil(net.catch(() => {}));          // keeps the worker alive until the late network answer is cached
    e.respondWith((async () => {
      const timeout = new Promise((r) => setTimeout(r, 1500, null));
      const res = await Promise.race([net.catch(() => null), timeout]);
      if (res) return res;
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await net; } catch { return (await caches.match('index.html')) || Response.error(); }
    })());
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    // Pinned versions never change: cache first.
    e.respondWith(caches.open(CDN).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
  }
});
