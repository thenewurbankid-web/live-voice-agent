// Offline Berlin POIs (data/berlin-pois.json) + online Overpass/Nominatim. No deps.
export const CATEGORIES = [
  { key: 'bar',        label: 'Bars',         night: true,  day: false, minutes: 60 },
  { key: 'pub',        label: 'Pubs',         night: true,  day: false, minutes: 60 },
  { key: 'club',       label: 'Clubs',        night: true,  day: false, minutes: 90 },
  { key: 'biergarten', label: 'Beer gardens', night: true,  day: true,  minutes: 60 },
  { key: 'cafe',       label: 'Cafés',        night: false, day: true,  minutes: 45 },
  { key: 'restaurant', label: 'Restaurants',  night: true,  day: true,  minutes: 75 },
  { key: 'sight',      label: 'Sights',       night: false, day: true,  minutes: 45 },
  { key: 'museum',     label: 'Museums',      night: false, day: true,  minutes: 90 },
  { key: 'park',       label: 'Parks',        night: false, day: true,  minutes: 40 },
];

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const DATA_URL = new URL('../data/berlin-pois.json', import.meta.url);

// [name, lng, lat] — offline geocode list
const AREAS = [
  ['Kreuzberg', 13.4030, 52.4990], ['Neukölln', 13.4380, 52.4810], ['Mitte', 13.4020, 52.5200],
  ['Friedrichshain', 13.4540, 52.5120], ['Prenzlauer Berg', 13.4240, 52.5400], ['Alexanderplatz', 13.4130, 52.5219],
  ['Warschauer Straße', 13.4488, 52.5058], ['Kottbusser Tor', 13.4177, 52.4990], ['Hackescher Markt', 13.4020, 52.5223],
  ['Schöneberg', 13.3520, 52.4830], ['Charlottenburg', 13.3040, 52.5160], ['Wedding', 13.3660, 52.5500],
  ['Moabit', 13.3400, 52.5300], ['Tempelhof', 13.4020, 52.4730], ['Treptow', 13.4690, 52.4890],
  ['Pankow', 13.4120, 52.5690], ['Spandau', 13.2000, 52.5350], ['Steglitz', 13.3200, 52.4560],
  ['Potsdamer Platz', 13.3760, 52.5096], ['Brandenburger Tor', 13.3777, 52.5163], ['Berlin Hauptbahnhof', 13.3695, 52.5251],
  ['Zoologischer Garten', 13.3320, 52.5070], ['Ostkreuz', 13.4690, 52.5030], ['Schlesisches Tor', 13.4420, 52.5006],
  ['Görlitzer Bahnhof', 13.4280, 52.4993], ['Hermannplatz', 13.4250, 52.4870], ['Rosenthaler Platz', 13.4010, 52.5298],
  ['Oranienburger Straße', 13.3930, 52.5250], ['Friedrichstraße', 13.3870, 52.5200], ['Nollendorfplatz', 13.3540, 52.4999],
  ['Kurfürstendamm', 13.3270, 52.5040], ['Schönhauser Allee', 13.4150, 52.5490], ['Eberswalder Straße', 13.4120, 52.5410],
  ['Boxhagener Platz', 13.4690, 52.5110], ['Gesundbrunnen', 13.3880, 52.5490], ['Westhafen', 13.3440, 52.5360],
  ['Südkreuz', 13.3650, 52.4750], ['Tempelhofer Feld', 13.4000, 52.4750], ['Museumsinsel', 13.3980, 52.5170],
  ['Checkpoint Charlie', 13.3904, 52.5075], ['Mauerpark', 13.4020, 52.5430], ['Gleisdreieck', 13.3740, 52.4990],
  ['Schlesischer Busch', 13.4560, 52.4910], ['Rixdorf', 13.4450, 52.4750],
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function distM(lng1, lat1, lng2, lat2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toPlace(row) {
  const [id, name, cat, lng, lat, oh] = row;
  return { id, name, cat, lng, lat, tags: oh ? { opening_hours: oh } : {} };
}

function overpassFilters(cat) {
  switch (cat) {
    case 'club': return ['nwr["amenity"="nightclub"]'];
    case 'sight': return ['nwr["tourism"~"^(attraction|viewpoint)$"]'];
    case 'museum': return ['nwr["tourism"="museum"]'];
    case 'park': return ['nwr["leisure"="park"]'];
    default: return [`nwr["amenity"="${cat}"]`];
  }
}

function elementToPlace(el) {
  const t = el.tags || {};
  if (!t.name) return null;
  const lng = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
  if (lng == null || lat == null) return null;
  let cat = null;
  if (t.amenity === 'nightclub') cat = 'club';
  else if (['bar', 'pub', 'biergarten', 'cafe', 'restaurant'].includes(t.amenity)) cat = t.amenity;
  else if (t.tourism === 'museum') cat = 'museum';
  else if (t.tourism === 'attraction' || t.tourism === 'viewpoint') cat = 'sight';
  else if (t.leisure === 'park') cat = 'park';
  if (!cat) return null;
  const tags = {};
  if (t.opening_hours) tags.opening_hours = t.opening_hours;
  if (t.website) tags.website = t.website;
  if (t.cuisine) tags.cuisine = t.cuisine;
  const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  if (addr) tags.addr = addr;
  return { id: el.id, name: t.name, cat, lng, lat, tags };
}

export class Places {
  constructor() { this._rows = null; this._loading = null; this._lastNominatim = 0; }

  async load() {
    if (this._rows) return this;
    if (!this._loading) {
      this._loading = (async () => {
        try {
          const res = await fetch(DATA_URL);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          this._rows = (await res.json()).map(toPlace);
        } catch (e) {
          console.warn('places: offline data unavailable', e);
          this._rows = [];
        }
      })();
    }
    await this._loading;
    return this;
  }

  async search({ cats, near, radiusM = 1500, query = '', limit = 20, online = false } = {}) {
    await this.load();
    const catSet = cats && cats.length ? new Set(cats) : null;
    const q = norm(query);
    let pool = this._rows;
    if (online && near) {
      try {
        const live = await this._overpass(catSet ? [...catSet] : CATEGORIES.map((c) => c.key), near, radiusM);
        if (live.length) pool = live;
      } catch (e) { console.warn('places: Overpass failed, using offline data', e); }
    }
    const out = [];
    for (const p of pool) {
      if (catSet && !catSet.has(p.cat)) continue;
      if (q && !norm(p.name).includes(q) && !norm(p.tags.cuisine || '').includes(q)) continue;
      if (near) {
        const d = distM(near.lng, near.lat, p.lng, p.lat);
        if (d > radiusM) continue;
        out.push({ ...p, distanceM: Math.round(d) });
      } else out.push({ ...p });
    }
    if (near) out.sort((a, b) => a.distanceM - b.distanceM);
    return out.slice(0, limit);
  }

  async _overpass(cats, near, radiusM) {
    const around = `(around:${Math.round(radiusM)},${near.lat},${near.lng})`;
    const body = cats.flatMap(overpassFilters).map((f) => `${f}["name"]${around};`).join('');
    const q = `[out:json][timeout:8];(${body});out center tags 500;`;
    // public Overpass is often slow or 502s: give up after 5 s so the offline results show instantly
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
    const json = await res.json();
    return (json.elements || []).map(elementToPlace).filter(Boolean);
  }

  async geocode(text, { online = false } = {}) {
    const q = norm(text);
    if (!q) return null;
    // 1. built-in neighbourhoods/stations (exact, then contained either way)
    let hit = AREAS.find(([n]) => norm(n) === q)
      || AREAS.find(([n]) => q.includes(norm(n)))
      || AREAS.find(([n]) => norm(n).includes(q) && q.length >= 4);
    if (hit) return { lng: hit[1], lat: hit[2], label: hit[0] };
    // 2. POI / sight name
    await this.load();
    let best = null;
    for (const p of this._rows) {
      const n = norm(p.name);
      if (n === q) { best = p; break; }
      if (!best && q.length >= 4 && n.includes(q)) best = p;
    }
    if (best) return { lng: best.lng, lat: best.lat, label: best.name };
    // 3. Nominatim (bounded to Berlin, <= 1 req/s)
    if (online) {
      const wait = this._lastNominatim + 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastNominatim = Date.now();
      try {
        const url = `${NOMINATIM}?format=json&limit=1&bounded=1&viewbox=13.08,52.68,13.77,52.33&q=${encodeURIComponent(text)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (res.ok) {
          const [r] = await res.json();
          if (r) return { lng: +r.lon, lat: +r.lat, label: (r.display_name || text).split(',').slice(0, 2).join(',').trim() };
        }
      } catch (e) { console.warn('places: Nominatim failed', e); }
    }
    return null;
  }
}
