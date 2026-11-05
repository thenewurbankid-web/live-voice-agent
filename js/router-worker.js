// Module worker: loads berlin-walk.bin + ngraph (pinned, jsdelivr) and answers route requests via router-core.js.
import { createRouter } from './router-core.js';
const GRAPH = '20.1.2', PATH = '1.6.1';
let router;
async function init(buf) {
  const [g, p] = await Promise.all([
    import(`https://cdn.jsdelivr.net/npm/ngraph.graph@${GRAPH}/+esm`),
    import(`https://cdn.jsdelivr.net/npm/ngraph.path@${PATH}/+esm`),
  ]);
  router = createRouter(buf, { createGraph: g.default || g.createGraph, aStar: p.aStar || p.default.aStar });
  return router.stats;
}
self.onmessage = async ({ data: { id, type, buffer, points } }) => {
  try {
    if (type === 'init') self.postMessage({ id, result: await init(buffer) });
    else if (type === 'route') self.postMessage({ id, result: router ? router.route(points) : null });
  } catch (e) { self.postMessage({ id, error: String(e?.message || e) }); }
};
