#!/usr/bin/env python3
"""Build data/berlin-walk.bin from an OSM .pbf. Usage: build-walk-graph.py in.osm.pbf out.bin

BINARY LAYOUT (little-endian, every section 4-byte aligned; coordinates are int32 micro-degrees = deg * 1e6)
  header, 9 x u32 = 36 bytes
    [0] magic 'BWG1' (0x31475742)   [1] N nodes   [2] E edges   [3] S names   [4] P polyline points
    [5] minLng [6] minLat [7] maxLng [8] maxLat   (i32 micro-degrees)
  nodes   N x { i32 lng, i32 lat }                      graph vertices (intersections, way ends)
  edges   E x { u32 a, u32 b, f32 lengthM, u32 nameId, u32 polyStart, u32 polyCount }   24 bytes, undirected
  poly    P x { i32 lng, i32 lat }                      interior shape points, ordered a -> b, edge e uses
                                                        poly[polyStart .. polyStart+polyCount)
  nameOff (S+1) x u32                                   byte offsets into nameBytes; name i = [off[i], off[i+1])
  nameBytes                                             UTF-8; nameId 0 is the empty string (unnamed way)
Graph: walkable highway=* ways (no motorway/trunk/construction/foot=no/access=private|no, no driveways/parking aisles),
cut at intersections and way ends, interior shape simplified with Douglas-Peucker (3 m), only the largest connected
component kept. Edge length is measured on the unsimplified geometry.
"""
import math, struct, sys
import osmium

OK = {'residential', 'living_street', 'pedestrian', 'footway', 'path', 'steps', 'service', 'track', 'unclassified',
      'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'road', 'corridor'}
R = 6371008.8
def hav(a, b):
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.ways = []
    def way(self, w):
        t = w.tags; hw = t.get('highway')
        if hw not in OK: return
        if t.get('foot') == 'no' or t.get('access') in ('private', 'no') and t.get('foot') not in ('yes', 'designated', 'permissive'): return
        if hw == 'service' and t.get('service') in ('driveway', 'parking_aisle', 'drive-through'): return
        if t.get('area') == 'yes': return
        pts = []
        for n in w.nodes:
            if not n.location.valid(): return
            pts.append((n.ref, n.lon, n.lat))
        if len(pts) >= 2: self.ways.append((t.get('name') or t.get('ref') or '', pts))

def dp(pts, eps):  # Douglas-Peucker on local metric projection; returns kept indices
    if len(pts) < 3: return list(range(len(pts)))
    k = math.cos(math.radians(pts[0][1]))
    xy = [(p[0] * 111320 * k, p[1] * 110574) for p in pts]
    keep = {0, len(pts) - 1}; stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop(); ax, ay = xy[i]; bx, by = xy[j]; dx, dy = bx - ax, by - ay; L = dx * dx + dy * dy
        md, mi = -1, -1
        for m in range(i + 1, j):
            px, py = xy[m]
            t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L))
            d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > md: md, mi = d, m
        if md > eps: keep.add(mi); stack += [(i, mi), (mi, j)]
    return sorted(keep)

def main(src, out):
    h = H(); h.apply_file(src, locations=True); ways = h.ways
    cnt = {}
    for _, pts in ways:
        for r, _, _ in pts: cnt[r] = cnt.get(r, 0) + 1
    names = {'': 0}; edges = []  # (refA, refB, len, nameId, [interior (lng,lat)])
    coord = {}
    for name, pts in ways:
        nid = names.setdefault(name, len(names))
        last = 0
        for r, lo, la in pts: coord[r] = (lo, la)
        for i in range(1, len(pts)):
            if i == len(pts) - 1 or cnt[pts[i][0]] > 1:
                seg = pts[last:i + 1]
                if seg[0][0] != seg[-1][0] or len(seg) > 3:
                    ll = [(p[1], p[2]) for p in seg]
                    ln = sum(hav(ll[k], ll[k + 1]) for k in range(len(ll) - 1))
                    keep = dp(ll, 3.0)
                    edges.append((seg[0][0], seg[-1][0], ln, nid, [ll[k] for k in keep[1:-1]]))
                last = i
    # largest connected component
    par = {}
    def f(x):
        while par.setdefault(x, x) != x: par[x] = par[par[x]]; x = par[x]
        return x
    for a, b, *_ in edges: par[f(a)] = f(b)
    sizes = {}
    for a, *_ in edges: r = f(a); sizes[r] = sizes.get(r, 0) + 1
    big = max(sizes, key=sizes.get)
    edges = [e for e in edges if f(e[0]) == big and e[0] != e[1] or (f(e[0]) == big and len(e[4]) > 0)]
    idx = {}
    for a, b, *_ in edges:
        for r in (a, b): idx.setdefault(r, len(idx))
    nodes = [None] * len(idx)
    for r, i in idx.items(): nodes[i] = coord[r]
    q = lambda v: int(round(v * 1e6))
    poly = []; eb = bytearray()
    for a, b, ln, nid, mid in edges:
        eb += struct.pack('<IIfIII', idx[a], idx[b], ln, nid, len(poly), len(mid))
        poly += [(q(lo), q(la)) for lo, la in mid]
    nb = b''.join(struct.pack('<ii', q(lo), q(la)) for lo, la in nodes)
    pb = b''.join(struct.pack('<ii', x, y) for x, y in poly)
    nl = [n for n, _ in sorted(names.items(), key=lambda kv: kv[1])]
    nbytes = [n.encode() for n in nl]; offs = [0]
    for s in nbytes: offs.append(offs[-1] + len(s))
    xs = [q(c[0]) for c in nodes]; ys = [q(c[1]) for c in nodes]
    head = struct.pack('<9I', 0x31475742, len(nodes), len(edges), len(nl), len(poly), *[v & 0xffffffff for v in (min(xs), min(ys), max(xs), max(ys))])
    body = b''.join(nbytes)
    with open(out, 'wb') as fh:
        fh.write(head + nb + bytes(eb) + pb + struct.pack('<%dI' % len(offs), *offs) + body)
    print(f'nodes={len(nodes)} edges={len(edges)} names={len(nl)} polyPts={len(poly)} bytes={36+len(nb)+len(eb)+len(pb)+4*len(offs)+len(body)}')

if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
