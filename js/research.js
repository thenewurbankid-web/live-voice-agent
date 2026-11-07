// Research mode: key-free and deterministic up to the final answer.
// 1) work out what the user needs (compare / how-to / recommend / explain / history / facts),
// 2) search Wikipedia en+de and DuckDuckGo, 3) read the top pages in full, in parallel,
// 4) rank sentences by overlap with the question (boosted for that need), 5) hand the brain numbered notes.
import { webSearch } from './web.js';

const STOP = new Set('a an the of to in on for and or but is are was were be been it this that these those what which who whom how why when where do does did can could should would i me my you your we our about with from at by as into than then so if please tell research look dig deep dive find out more some any best'.split(' '));

export const NEEDS = {
  compare:   { re: /\b(vs\.?|versus|compare|comparison|difference|better|or)\b/, boost: /\b(than|whereas|while|unlike|both|however|more|less|faster|cheaper|larger|smaller)\b/i, ask: 'Compare them side by side and say which fits which situation.' },
  howto:     { re: /\b(how (do|to|can|should)|steps?|guide|setup|set up|install|make|get to)\b/, boost: /\b(first|then|next|finally|step|use|requires?|need|must|can be)\b/i, ask: 'Give the practical steps in order.' },
  recommend: { re: /\b(best|recommend|should i|worth|good|top|which one)\b/, boost: /\b(popular|known for|best|famous|recommended|notable|well-known|award)\b/i, ask: 'Give a clear recommendation with the reason.' },
  history:   { re: /\b(history|when|origin|founded|built|started|timeline)\b/, boost: /\b(1[0-9]{3}|20[0-9]{2}|century|founded|built|established|opened|began)\b/i, ask: 'Tell it as a short timeline.' },
  explain:   { re: /\b(why|what is|what are|explain|meaning|mean|works?)\b/, boost: /\b(is a|are|because|refers to|means|consists|used to|known as)\b/i, ask: 'Explain it simply.' },
};

export function detectNeed(q) {
  const t = q.toLowerCase();
  for (const [k, v] of Object.entries(NEEDS)) if (v.re.test(t)) return k;
  return 'facts';
}

export function topicOf(q) {
  return q.replace(/^(please\s+)?(can you\s+)?(do (a|some)\s+)?(research|look into|dig into|deep dive( into)?|find out( about)?|read up on|recherchiere)\s*(on|about|into)?\s*/i, '')
    .replace(/[?.!]+$/, '').trim() || q;
}

// Words that describe the kind of answer, not the subject: kept for need detection, dropped from search and ranking.
const NEED_WORDS = new Set('history origin timeline compare comparison versus difference better how get make steps guide explain meaning mean why works recommend worth good top which one should when founded built started'.split(' '));
const terms = (s) => [...new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((w) => !STOP.has(w));

async function getJSON(url, ms = 7000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}

// Wikivoyage (travel guide, same open MediaWiki API with CORS): practical how-to and where-to for trips.
async function voyageSearch(query, limit = 2) {
  const j = await getJSON(`https://en.wikivoyage.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`);
  return (j?.query?.search || []).map((h) => ({ title: h.title + ' (Wikivoyage)', snippet: h.snippet.replace(/<[^>]*>/g, ''), url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, source: 'wikivoyage' }));
}

// Full plain-text article (not just the summary), capped.
async function readWiki(url) {
  const m = /^https?:\/\/([a-z-]+)\.(wikipedia|wikivoyage)\.org\/wiki\/([^?#]+)/i.exec(url || '');
  if (!m) return '';
  const j = await getJSON(`https://${m[1]}.${m[2]}.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&origin=*&titles=${m[3]}`);
  const page = j && Object.values(j.query?.pages || {})[0];
  return String(page?.extract || '').slice(0, 20000);
}

const sentences = (text) => (text.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+/g) || []).map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 400);

// → { topic, need, notes: [{ n, text }], sources: [{ n, title, url }] }
export async function research(question, { onStep = () => {}, maxSources = 4, maxNotes = 8 } = {}) {
  const topic = topicOf(question), need = detectNeed(question);
  const core = terms(topic).filter((w) => !NEED_WORDS.has(w));
  const query = core.join(' ') || topic;
  onStep(`Searching for “${query}”`);
  // A comparison reads each side's own page first ("A vs B" → A, B), then the joint search.
  const sides = need === 'compare' ? topic.split(/\s+(?:vs\.?|versus|or|and|compared to)\s+/i).map((x) => x.trim()).filter((x) => x.length > 2).slice(0, 2) : [];
  const lists = await Promise.all([...sides.map((x) => webSearch(x, { limit: 2 })), webSearch(query, { limit: 8 }), ['howto', 'recommend'].includes(need) ? voyageSearch(query) : []]);
  const seen = new Set();
  let hits = lists.flat().filter((h) => h && !seen.has(h.url) && seen.add(h.url));
  if (!hits.length) return { topic, need, notes: [], sources: [] };

  hits = hits.slice(0, maxSources + 3);
  onStep(`Reading ${hits.length} sources`);
  const full = await Promise.all(hits.map(async (h) => ((await readWiki(h.url)) || h.snippet || '')));
  // Keep a source only if it covers most of the subject words (drops "Irving Berlin" for "Berlin WelcomeCard").
  const covers = (words, h, text) => { const w = new Set(terms(h.title + ' ' + text.slice(0, 3000))); return words.length ? words.filter((x) => w.has(x)).length / words.length : 1; };
  const sideTerms = sides.map((x) => terms(x).filter((w) => !NEED_WORDS.has(w)));
  const need0 = core.length > 2 ? 0.6 : 1;          // 1–2 subject words: all must appear
  const titles = new Set();
  const keep = hits.map((h, i) => ({ h, text: full[i], c: Math.max(covers(core, h, full[i]), ...sideTerms.map((t) => covers(t, h, full[i]))) }))
    .filter((x) => x.c >= need0)
    .filter((x) => { const k = x.h.title.toLowerCase(); return !titles.has(k) && titles.add(k); })   // en + de copy of one article
    .sort((a, b) => b.c - a.c).slice(0, maxSources);
  if (!keep.length) return { topic, need, notes: [], sources: [] };
  const picked = keep.map((x) => x.h), texts = keep.map((x) => x.text);

  onStep('Picking what matters for you');
  const q = core.length ? core : terms(question), boost = NEEDS[need]?.boost;
  const scored = [];
  texts.forEach((text, i) => sentences(text).forEach((s, k) => {
    const w = terms(s); let score = 0;
    for (const x of q) if (w.includes(x)) score += 2;
    if (!score) return;                           // a note must mention the subject
    if (boost?.test(s)) score += 1.5;
    score += Math.max(0, 1.5 - k * 0.05);       // lead sentences carry the gist
    if (score > 1.5) scored.push({ src: i, text: s, score });
  }));
  scored.sort((a, b) => b.score - a.score);
  const perSrc = {}, notes = [];
  for (const s of scored) {                     // spread notes across sources
    if ((perSrc[s.src] = (perSrc[s.src] || 0) + 1) > 3) continue;
    notes.push(s); if (notes.length >= maxNotes) break;
  }
  const used = [...new Set(notes.map((x) => x.src))].sort((a, b) => a - b);
  const num = new Map(used.map((src, i) => [src, i + 1]));
  return {
    topic, need,
    notes: notes.map((x) => ({ n: num.get(x.src), text: x.text })),
    sources: used.map((src) => ({ n: num.get(src), title: picked[src].title, url: picked[src].url })),
  };
}

// The prompt the brain answers from: numbered notes + what kind of answer the user needs.
export function researchPrompt(question, r) {
  return `${question}\n\n(Research notes from the web, numbered by source:\n${r.notes.map((x) => `[${x.n}] ${x.text}`).join('\n')}\n` +
    `Answer only from these notes. ${NEEDS[r.need]?.ask || 'Give the key facts.'} Use 3 to 5 short sentences, cite like [1], and say if the notes don't cover something.)`;
}
