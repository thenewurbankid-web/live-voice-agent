// App-shell + CDN cache so the app starts with no network after the first visit.
// Model weights are cached by WebLLM / transformers.js themselves (Cache API), and the
// Berlin tiles by js/map.js, so they are deliberately not duplicated here.
const SHELL = 'live-shell-v10';
const CDN = 'live-cdn-v1';
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/app.js', 'js/brain.js', 'js/llm-worker.js', 'js/ml-worker.js', 'js/ears.js', 'js/voice.js', 'js/eyes.js', 'js/translate.js', 'js/map.js', 'js/ocr.js', 'js/web.js', 'js/routing.js', 'js/navigator.js', 'js/places.js', 'js/planner.js', 'js/plans-store.js', 'js/plan-ui.js', 'js/memory.js', 'js/sounds.js', 'js/aware.js', 'js/graph-memory.js', 'js/maps-ui.js', 'js/offline-router.js', 'js/router-worker.js', 'js/router-core.js', 'data/berlin-pois.json',
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
    // Network first for the shell so updates land; cache when offline.
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
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
