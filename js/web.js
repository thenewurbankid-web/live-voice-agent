// Agent web access: key-free, CORS-enabled public APIs only (Wikipedia en/de, DuckDuckGo Instant Answer).
const TIMEOUT_MS = 6000;

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

async function wikiSearch(lang, query, limit) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const j = await getJSON(u);
  const hits = j?.query?.search;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => ({
    title: h.title,
    snippet: stripHtml(h.snippet),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    source: `wikipedia-${lang}`,
  }));
}

async function ddgSearch(query) {
  const j = await getJSON(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
  if (!j) return [];
  const out = [];
  if (j.AbstractText && j.AbstractURL) {
    out.push({ title: j.Heading || query, snippet: j.AbstractText, url: j.AbstractURL, source: 'duckduckgo' });
  }
  for (const r of j.RelatedTopics || []) {
    if (r.Text && r.FirstURL) out.push({ title: r.Text.split(' - ')[0], snippet: r.Text, url: r.FirstURL, source: 'duckduckgo' });
  }
  return out;
}

export async function webSearch(query, { limit = 5 } = {}) {
  try {
    if (!query || !String(query).trim()) return [];
    const [en, de, ddg] = await Promise.all([
      wikiSearch('en', query, limit).catch(() => []),
      wikiSearch('de', query, limit).catch(() => []),
      ddgSearch(query).catch(() => []),
    ]);
    // interleave: ddg abstract first, then alternate en/de, dedupe by url
    const merged = [];
    const seen = new Set();
    const push = (r) => { if (r && !seen.has(r.url)) { seen.add(r.url); merged.push(r); } };
    push(ddg[0]);
    for (let i = 0; i < Math.max(en.length, de.length); i++) { push(en[i]); push(de[i]); }
    ddg.slice(1).forEach(push);
    return merged.slice(0, limit);
  } catch { return []; }
}

export async function readPage(url) {
  try {
    const m = /^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^?#]+)/i.exec(String(url || ''));
    if (!m) return '';
    const j = await getJSON(`https://${m[1].toLowerCase()}.wikipedia.org/api/rest_v1/page/summary/${m[2]}`);
    return j?.extract ? String(j.extract) : '';
  } catch { return ''; }
}

export function needsWeb(text) {
  return /\b(search|look\s?up|google|latest|news|today|current(ly)?|who is|who was|what is|what's|when did|how many|weather|price of|suche|nachrichten|aktuell|wer ist|was ist)\b/i.test(String(text || ''));
}
