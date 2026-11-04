#!/usr/bin/env bash
# Builds data/berlin-pois.json from Overpass. Usage: tools/build-pois.sh [--no-restaurant-without-hours]
set -euo pipefail
cd "$(dirname "$0")/.."
BBOX="52.33,13.08,52.68,13.77"   # south,west,north,east
RAW="$(mktemp)"; trap 'rm -f "$RAW"' EXIT
Q="[out:json][timeout:180];(
nwr[name][amenity~'^(bar|pub|nightclub|biergarten|cafe|restaurant)\$']($BBOX);
nwr[name][tourism~'^(attraction|museum|viewpoint)\$']($BBOX);
nwr[name][leisure=park]($BBOX););out center tags;"
for EP in https://overpass-api.de/api/interpreter https://overpass.private.coffee/api/interpreter https://overpass.kumi.systems/api/interpreter; do
  curl -sS --fail -A "live-voice-agent-build-pois/1.0" -H "Accept: */*" -m 200 --data-urlencode "data=$Q" "$EP" -o "$RAW" && break || echo "retry next endpoint" >&2
done
build() { jq -c --argjson drop "$1" '
 [ .elements[] | select(.tags.name) |
   (.lon // .center.lon) as $lng | (.lat // .center.lat) as $lat | select($lng and $lat) |
   (if .tags.amenity=="nightclub" then "club"
    elif (.tags.amenity|IN("bar","pub","biergarten","cafe","restaurant")) then .tags.amenity
    elif .tags.tourism=="museum" then "museum"
    elif (.tags.tourism|IN("attraction","viewpoint")) then "sight"
    elif .tags.leisure=="park" then "park" else empty end) as $cat |
   select($cat) | select(($drop|not) or $cat!="restaurant" or .tags.opening_hours) |
   [.id, .tags.name, $cat, (($lng*100000|round)/100000), (($lat*100000|round)/100000), (.tags.opening_hours // null)] ]' "$RAW"; }
build false > data/berlin-pois.json
SIZE=$(wc -c < data/berlin-pois.json)
if [ "$SIZE" -gt 5000000 ]; then echo "too big ($SIZE), dropping restaurants without opening_hours"; build true > data/berlin-pois.json; fi
echo "$(jq length data/berlin-pois.json) POIs, $(wc -c < data/berlin-pois.json) bytes"
