#!/usr/bin/env bash
# Build + pack the component and install it, together with CSS, into a runtime
# directory *outside* the repo tree. This matters: Components.js scans node_modules
# by walking UP from the main-module path, so a runtime inside the repo would pull
# in the repo's dev dependencies (componentsjs-generator's @comunica metadata) and
# fail to boot. An out-of-repo runtime sees only CSS + this component.
#
# Usage: bash perf/setup.sh   (then: node perf/bench.mjs)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="${CCS_PERF_RUNTIME:-/tmp/ccs-cache-perf-runtime}"

cd "$REPO"
echo "Building + packing the component…"
npm run build >/dev/null
TGZ="$REPO/$(npm pack 2>/dev/null | tail -1)"
echo "  packed: $TGZ"

echo "Installing runtime at $RUNTIME …"
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
cat > "$RUNTIME/package.json" <<EOF
{
  "name": "ccs-perf-runtime",
  "version": "0.0.0",
  "private": true,
  "dependencies": {
    "@solid/community-server": "^7.1.9",
    "@jeswr/css-cached-storage": "file:$TGZ"
  }
}
EOF
( cd "$RUNTIME" && npm install >/dev/null 2>&1 )
echo "Runtime ready. Run: CCS_PERF_RUNTIME=$RUNTIME node perf/bench.mjs"
