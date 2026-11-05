#!/usr/bin/env bash
# Reproduces data/berlin-walk.bin from the Geofabrik Berlin extract (binary layout: see build-walk-graph.py header).
# Needs python3 (venv + `pip install osmium` is created automatically) and curl. Work dir: $WORK (default /tmp/berlin-walk).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; WORK="${WORK:-/tmp/berlin-walk}"
mkdir -p "$WORK/pbf"
[ -s "$WORK/pbf/berlin-latest.osm.pbf" ] || curl -L -o "$WORK/pbf/berlin-latest.osm.pbf" https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
[ -x "$WORK/venv/bin/python" ] || { python3 -m venv "$WORK/venv"; "$WORK/venv/bin/pip" install -q osmium; }
"$WORK/venv/bin/python" "$HERE/build-walk-graph.py" "$WORK/pbf/berlin-latest.osm.pbf" "$HERE/../data/berlin-walk.bin"
