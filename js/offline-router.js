// Offline walking routes on the OSM network in data/berlin-walk.bin (A* in a module worker, see router-worker.js).
const URL_BIN = new URL('../data/berlin-walk.bin', import.meta.url).href, CACHE = 'berlin-walk-v1';
let worker, readyP, seq = 0;
const pending = new Map();

async function fetchBin(onProgress) {
  const cache = await caches.open(CACHE).catch(() => null), hit = await cache?.match(URL_BIN);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(URL_BIN);
  if (!res.ok) throw new Error(`berlin-walk.bin ${res.status}`);
  const total = +res.headers.get('x-content-length') || +res.headers.get('content-length') || 0, chunks = [];
  let got = 0;
  const rd = res.body.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.(total ? Math.min(1, got / total) : 0, got);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  await cache?.put(URL_BIN, new Response(buf.slice().buffer)).catch(() => {});
  return buf.buffer;
}

function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer || []);
  });
}

export function ensureGraph(onProgress) {
  return readyP ||= (async () => {
    try {
      const buffer = await fetchBin(onProgress);
      worker = new Worker(new URL('./router-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: { id, result, error } }) => {
        const p = pending.get(id); pending.delete(id);
        error ? p?.reject(new Error(error)) : p?.resolve(result);
      };
      worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message)); pending.clear(); };
      await call({ type: 'init', buffer }, [buffer]);
      onProgress?.(1);
      return true;
    } catch (e) { readyP = null; worker?.terminate(); worker = null; throw e; }
  })();
}

export async function routeOffline(points) {
  try { await ensureGraph(); } catch { return null; }
  try { return await call({ type: 'route', points: points.map((p) => ({ lng: p.lng, lat: p.lat })) }); } catch { return null; }
}
