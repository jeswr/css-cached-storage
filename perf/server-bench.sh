#!/usr/bin/env bash
# AUTHORED-BY Claude Opus 4.8
#
# SERVER-LEVEL oha load benchmark for @jeswr/css-cached-storage.
#
# Mirrors the methodology of the Rust solid-server-rs bench (bench/run.sh): an `oha` HTTP concurrency
# sweep reporting sustained RPS + p50/p99 latency. Here we boot a FULL Community Solid Server (CSS) in
# THREE configurations, one at a time on its own port, and measure how the storage layer performs:
#
#   A — cached-file : CSS + this package's CachingDataAccessor wrapping FileDataAccessor (read cache +
#                     write-back queue) — perf/server-configs/A-cached-file.json
#   B — plain-file  : stock CSS file storage, plain FileDataAccessor, NO cache — B-plain-file.json
#   C — in-memory   : default CSS in-memory store (the upper-bound ceiling) — C-in-memory.json
#
# All three on the SAME CSS version (the repo's @solid/community-server dep), the SAME machine,
# back-to-back. To ISOLATE the storage delta we strip auth out of the measurement: every config uses
# `allow-all` authorization + a writable root (no WAC, no DPoP, no token), so `oha` GETs/PUTs anonymously.
# The numbers therefore reflect the STORAGE path (+ CSS HTTP/LDP framing), not auth overhead.
#
# WORKLOADS (oha sweep across concurrency; -z duration per level, one discarded warm-up):
#   1. hot-read  — repeated GET of the SAME small resource (cache-HIT path; cache WARMED first).
#   2. cold-read — GET across MANY distinct resources (cache-miss / churn; LRU behaviour).
#   3. write     — PUT (write-back path; cache ACKs before disk). Re-seeded between configs.
#   4. mixed     — 80% read / 20% write (optional, BENCH_MIXED=1).
#
# Reports, per config per workload: RPS, p50, p99 -> perf/server-results/results.tsv, and a
# config-vs-config comparison the SERVER-BENCH.md write-up consumes. The box may be LOADED, so the
# absolute wall-clock numbers are ADVISORY; the trustworthy signal is the RELATIVE A/B/C deltas
# measured back-to-back under the same conditions (same caveat as the Rust bench).
#
# Re-run: `bash perf/server-bench.sh`. Override knobs via env (see CONFIG). Requires `oha` on PATH
# (`brew install oha` / `cargo install oha`) — a local DEV tool, NOT a project dependency.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# --- CONFIG (override via env) ------------------------------------------------------------------
# The CSS runtime (CSS + this component installed OUT OF REPO, so Components.js does not scan the repo's
# dev tooling — see perf/setup.sh / perf/README.md). Reused from the DataAccessor micro-bench setup.
RUNTIME="${CCS_PERF_RUNTIME:-/tmp/ccs-cache-perf-runtime}"
PORT_A="${BENCH_PORT_A:-3020}"
PORT_B="${BENCH_PORT_B:-3021}"
PORT_C="${BENCH_PORT_C:-3022}"
# oha dials the IPv4 literal: on macOS `localhost` resolves to IPv6 ::1 first and oha (unlike curl) does
# NOT fall back to IPv4, so a `localhost` dial gets "Connection refused" against the IPv4 listener. CSS
# binds all interfaces, but we dial 127.0.0.1 to be safe. (Same trap the Rust bench documents.)
CONNECT_HOST="${BENCH_CONNECT_HOST:-127.0.0.1}"
DURATION="${BENCH_DURATION:-5s}"             # oha -z per concurrency level (short — a stable rate, not a long hammer)
WARMUP_DURATION="${BENCH_WARMUP:-3s}"        # discarded warm-up before each measured sweep
# CSS is single-threaded Node and SATURATES by ~c4 (at c=1 it was already only ~86 RPS), so a
# Rust-scale c8/c16/c32/c64 sweep just measures CSS at saturation. Dialled BACK to a low-concurrency
# sweep that lands on CSS's real operating range — the cache delta is what we're after, not the
# saturation ceiling. (Override with BENCH_CONCURRENCY if a wider sweep is ever wanted.)
CONCURRENCY="${BENCH_CONCURRENCY:-1 2 4}"
# QUIET-BOX GUARD: max 1-minute load average tolerated before the run starts (and the bar we re-check
# against between configs). The box has 8 cores; we require load well UNDER that (a genuinely quiet
# box) so the loopback load-generator + CSS aren't fighting other work and A/B/C share conditions. If
# the box never goes quiet within the timeout, the harness ABORTS rather than publish noisy numbers as
# clean. Set BENCH_SKIP_LOAD_GUARD=1 to bypass (NOT advised — the whole point of the re-run).
LOAD_GUARD_MAX="${BENCH_LOAD_GUARD_MAX:-2.0}"
LOAD_GUARD_TIMEOUT_S="${BENCH_LOAD_GUARD_TIMEOUT_S:-3600}"   # how long to wait for the box to go quiet
LOAD_GUARD_POLL_S="${BENCH_LOAD_GUARD_POLL_S:-30}"           # poll interval while waiting
# COLD_SET = distinct resources seeded for the cold-read churn workload. MUST be a power of ten so the
# churn regex (res-[0-9]{WIDTH}) spans EXACTLY the seeded range — otherwise the random churn URLs hit
# unseeded paths and oha measures the 404 NOT-FOUND path (which oha counts as success!) instead of real
# cache-miss reads of EXISTING resources. The script validates this below and derives WIDTH from it.
COLD_SET="${BENCH_COLD_SET:-1000}"
BODY_BYTES="${BENCH_BODY_BYTES:-256}"        # size of each seeded/written resource (small -> cacheable)
RUN_MIXED="${BENCH_MIXED:-0}"                # set 1 to also run the 80/20 mixed workload
RESULTS="$HERE/server-results"

# --- pre-flight ---------------------------------------------------------------------------------
command -v oha >/dev/null 2>&1 || { echo "ERROR: 'oha' not found on PATH. Install: brew install oha (or cargo install oha). A local DEV tool, NOT a project dep." >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required (to parse oha JSON)." >&2; exit 1; }

# COLD_SET must be a power of ten so the churn regex spans EXACTLY the seeded resources (no 404s — see
# the COLD_SET comment). Derive the zero-pad WIDTH = number of digits in (COLD_SET-1); validate exact.
case "$COLD_SET" in
  10) COLD_WIDTH=1 ;; 100) COLD_WIDTH=2 ;; 1000) COLD_WIDTH=3 ;; 10000) COLD_WIDTH=4 ;; 100000) COLD_WIDTH=5 ;;
  *) echo "ERROR: BENCH_COLD_SET must be a power of ten (10/100/1000/10000/100000) so the churn regex spans exactly the seeded range; got $COLD_SET." >&2; exit 1 ;;
esac
# The exact churn regex: res- followed by WIDTH digits → matches res-0..res-(COLD_SET-1), every one seeded.
COLD_RX_SUFFIX="res-[0-9]{${COLD_WIDTH}}"

CSS_BIN="$RUNTIME/node_modules/@solid/community-server/bin/server.js"
if [ ! -x "$CSS_BIN" ] && [ ! -f "$CSS_BIN" ]; then
  echo "ERROR: CSS runtime not found at $RUNTIME." >&2
  echo "       Build the out-of-repo runtime first:  bash perf/setup.sh" >&2
  echo "       (it installs CSS + this component into $RUNTIME so Components.js can boot the configs)." >&2
  exit 1
fi
CSS_VERSION="$(node -e "console.log(require('$RUNTIME/node_modules/@solid/community-server/package.json').version)")"
OHA_VERSION="$(oha --version 2>/dev/null | awk '{print $2}')"

rm -rf "$RESULTS"
mkdir -p "$RESULTS"
RESULTS_TSV="$RESULTS/results.tsv"
printf 'config\tworkload\tconcurrency\trps\tsuccess_rate\tp50_ms\tp99_ms\tp999_ms\n' > "$RESULTS_TSV"

# --- quiet-box guard ----------------------------------------------------------------------------
# Read the 1-minute load average (the first of the three `uptime` figures). Portable parse: take the
# token after "load average:" / "load averages:" and strip a trailing comma. macOS prints
# "load averages: 1.23 4.56 7.89"; Linux "load average: 1.23, 4.56, 7.89".
one_min_load() {
  uptime | sed -E 's/.*load averages?: *//; s/,.*//; s/ .*//'
}

# float "a < b" using awk (bash has no float compare).
flt_lt() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a < b)}'; }

# Block until the 1-min load average is < LOAD_GUARD_MAX, or give up after LOAD_GUARD_TIMEOUT_S.
# Returns 0 once quiet; exits the script non-zero on timeout (we do NOT publish noisy numbers as clean).
wait_for_quiet_box() {
  local waited=0 load
  load="$(one_min_load)"
  if flt_lt "$load" "$LOAD_GUARD_MAX"; then
    echo ">> QUIET-BOX GUARD: 1-min load $load < $LOAD_GUARD_MAX — box is quiet, starting run."
    return 0
  fi
  echo ">> QUIET-BOX GUARD: 1-min load $load >= $LOAD_GUARD_MAX — WAITING for the box to go quiet"
  echo ">>   (polling every ${LOAD_GUARD_POLL_S}s, up to ${LOAD_GUARD_TIMEOUT_S}s). $(uptime)"
  while [ "$waited" -lt "$LOAD_GUARD_TIMEOUT_S" ]; do
    sleep "$LOAD_GUARD_POLL_S"
    waited=$((waited + LOAD_GUARD_POLL_S))
    load="$(one_min_load)"
    if flt_lt "$load" "$LOAD_GUARD_MAX"; then
      echo ">> QUIET-BOX GUARD: 1-min load $load < $LOAD_GUARD_MAX after ${waited}s — box is quiet, starting run."
      return 0
    fi
    echo ">>   …still busy after ${waited}s: 1-min load $load (need < $LOAD_GUARD_MAX). $(uptime)"
  done
  echo "ERROR: QUIET-BOX GUARD timed out after ${LOAD_GUARD_TIMEOUT_S}s — 1-min load never fell below $LOAD_GUARD_MAX (last $load)." >&2
  echo "       NOT publishing load-contaminated numbers as clean. Re-run when the box is idle, or raise BENCH_LOAD_GUARD_TIMEOUT_S." >&2
  exit 1
}

# --- helpers ------------------------------------------------------------------------------------
# Parse one oha JSON result -> a TSV row (+ a one-line console summary). oha latencies are SECONDS.
parse_and_record() { # $1=config $2=workload $3=concurrency $4=json-file
  python3 - "$1" "$2" "$3" "$4" "$RESULTS_TSV" <<'PY'
import json, sys
config, workload, conc, jf, tsv = sys.argv[1:6]
with open(jf) as f:
    d = json.load(f)
s = d["summary"]
lp = d.get("latencyPercentiles") or {}
def ms(x):
    return round(x * 1000.0, 3) if isinstance(x, (int, float)) else -1.0
row = [config, workload, conc, f'{s["requestsPerSec"]:.1f}', f'{s["successRate"]:.4f}',
       str(ms(lp.get("p50"))), str(ms(lp.get("p99"))), str(ms(lp.get("p99.9")))]
with open(tsv, "a") as f:
    f.write("\t".join(row) + "\n")
print(f'  [{config} {workload} c={conc}] rps={s["requestsPerSec"]:.0f} '
      f'success={s["successRate"]:.3f} p50={ms(lp.get("p50"))}ms p99={ms(lp.get("p99"))}ms')
PY
}

# GET sweep over a single fixed URL (hot-read).
run_get_fixed() { # $1=config $2=workload $3=url
  local config="$1" workload="$2" url="$3"
  echo ">> [$config] $workload: GET $url"
  oha --no-tui --output-format quiet -c 16 -z "$WARMUP_DURATION" "$url" >/dev/null 2>&1 || true
  for c in $CONCURRENCY; do
    local jf="$RESULTS/${config}-${workload}-c${c}.json"
    oha --no-tui --output-format json -c "$c" -z "$DURATION" "$url" > "$jf" 2>/dev/null
    parse_and_record "$config" "$workload" "$c" "$jf"
  done
}

# GET sweep over a CHURN URL set (cold-read): oha `--rand-regex-url` hits a random DISTINCT path per
# request, spread across the whole seeded set, so reads churn over many keys (exercising the cache's
# per-key lookup + LRU rather than the single hot resource). The regex spans EXACTLY the seeded range
# (res-0..res-(COLD_SET-1), all existing — never a 404). NB: with the 1 GiB default cache the whole
# small cold set fits in cache after warm-up, so for config A this becomes a many-key warm read; to
# force genuine eviction churn, shrink the cache or raise COLD_SET past it (see SERVER-BENCH.md).
run_get_churn() { # $1=config $2=workload $3=base (…/cold/)
  local config="$1" workload="$2" base="$3"
  # WIDTH-digit zero-padded numeric suffix spanning EXACTLY the seeded range — oha generates a random
  # match per request, and every match (res-0..res-(COLD_SET-1)) is a resource that EXISTS (a real
  # cache-miss read, NOT a 404). See the COLD_SET / COLD_WIDTH derivation in pre-flight.
  local rx="${base}${COLD_RX_SUFFIX}"
  echo ">> [$config] $workload: GET (churn) $rx  (over $COLD_SET seeded resources)"
  oha --no-tui --output-format quiet --rand-regex-url -c 16 -z "$WARMUP_DURATION" "$rx" >/dev/null 2>&1 || true
  for c in $CONCURRENCY; do
    local jf="$RESULTS/${config}-${workload}-c${c}.json"
    oha --no-tui --output-format json --rand-regex-url -c "$c" -z "$DURATION" "$rx" > "$jf" 2>/dev/null
    parse_and_record "$config" "$workload" "$c" "$jf"
  done
}

# PUT sweep (write-back path). Each request writes a distinct churn path so writes don't collide; the
# body is BODY_BYTES of 'x'. We re-seed/reset the write area per config before this runs.
run_put_churn() { # $1=config $2=workload $3=base (…/write/)
  local config="$1" workload="$2" base="$3"
  local rx="${base}w-[0-9]{7}"
  local body; body="$(printf 'x%.0s' $(seq 1 "$BODY_BYTES"))"
  echo ">> [$config] $workload: PUT (churn) $rx  (body=${BODY_BYTES}B)"
  oha --no-tui --output-format quiet --rand-regex-url -m PUT -T text/plain -d "$body" -c 16 -z "$WARMUP_DURATION" "$rx" >/dev/null 2>&1 || true
  for c in $CONCURRENCY; do
    local jf="$RESULTS/${config}-${workload}-c${c}.json"
    oha --no-tui --output-format json --rand-regex-url -m PUT -T text/plain -d "$body" -c "$c" -z "$DURATION" "$rx" > "$jf" 2>/dev/null
    parse_and_record "$config" "$workload" "$c" "$jf"
  done
}

# --- boot one CSS config, seed it, run the workloads, tear it down ------------------------------
bench_config() { # $1=config-label $2=config-file $3=port
  local config="$1" cfgfile="$2" port="$3"
  local base="http://${CONNECT_HOST}:${port}/"
  local datadir="/tmp/ccs-server-bench-${port}"
  rm -rf "$datadir"; mkdir -p "$datadir"

  echo ""
  echo "==================================================================================="
  echo ">> CONFIG $config — $(basename "$cfgfile")  (port $port, base $base)"
  echo ">> Box load AT THIS CONFIG's start: $(uptime)"
  echo "==================================================================================="
  # Record the per-config load context so SERVER-BENCH.md can show A/B/C ran under the same conditions.
  printf '%s\t%s\t%s\n' "$config" "$(one_min_load)" "$(uptime)" >> "$RESULTS/load-context.tsv"
  # Re-assert the quiet-box bar before each config: if the box spiked between configs, the run is no
  # longer comparable. Fail loud rather than silently publish a contaminated config.
  local _l; _l="$(one_min_load)"
  if ! flt_lt "$_l" "$LOAD_GUARD_MAX"; then
    echo "ERROR: box load spiked to 1-min $_l (>= $LOAD_GUARD_MAX) before config $config — A/B/C would no longer be comparable." >&2
    echo "       Aborting so we don't publish a load-contaminated config. Re-run on a quiet box." >&2
    exit 1
  fi

  # Boot CSS with this config against a throwaway data dir. -m RUNTIME so Components.js resolves the
  # css:… imports + this package's component from the out-of-repo runtime.
  node "$CSS_BIN" -c "$cfgfile" -m "$RUNTIME" -f "$datadir" -p "$port" -b "$base" -l warn \
      > "$RESULTS/${config}-server.log" 2>&1 &
  local server_pid=$!
  # shellcheck disable=SC2064
  trap "kill $server_pid 2>/dev/null || true" EXIT INT TERM

  # Readiness: root container reachable.
  local ready=0
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null -w '%{http_code}' "$base" 2>/dev/null | grep -qE '2..|3..'; then ready=1; break; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then echo "ERROR: CSS exited early; log:" >&2; cat "$RESULTS/${config}-server.log" >&2; exit 1; fi
    sleep 0.5
  done
  [ "$ready" = 1 ] || { echo "ERROR: CSS did not become ready; log:" >&2; cat "$RESULTS/${config}-server.log" >&2; exit 1; }
  echo ">> [$config] server ready."

  # --- seed (anonymous; allow-all so no token) ---
  echo ">> [$config] seeding: containers + 1 hot resource + ${COLD_SET} cold resources …"
  # Containers (PUT a container = trailing slash; CSS creates intermediate containers on resource PUT,
  # but create them explicitly so the first write is clean).
  curl -s -o /dev/null -X PUT -H 'content-type: text/turtle' "${base}bench/" || true
  curl -s -o /dev/null -X PUT -H 'content-type: text/turtle' "${base}bench/cold/" || true
  curl -s -o /dev/null -X PUT -H 'content-type: text/turtle' "${base}bench/write/" || true
  # Hot resource (the single cache-HIT target).
  local body; body="$(printf 'x%.0s' $(seq 1 "$BODY_BYTES"))"
  curl -s -o /dev/null -X PUT -H 'content-type: text/plain' -d "$body" "${base}bench/hot" \
    || { echo "ERROR: could not PUT the hot resource (public write broken?)" >&2; exit 1; }
  # Verify anonymous read works (the whole isolation premise).
  local hot_code; hot_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}bench/hot")"
  [ "$hot_code" = 200 ] || { echo "ERROR: anonymous GET of hot resource != 200 (got $hot_code) — allow-all config broken" >&2; cat "$RESULTS/${config}-server.log" >&2; exit 1; }
  # Cold set: COLD_SET distinct WIDTH-digit-padded resources, seeded concurrently for speed.
  seed_cold "$base"
  # Verify the churn range is fully seeded: probe the FIRST + LAST resource the churn regex can hit.
  local first_code last_code
  first_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}bench/cold/res-$(printf "%0${COLD_WIDTH}d" 0)")"
  last_code="$(curl -s -o /dev/null -w '%{http_code}' "${base}bench/cold/res-$(printf "%0${COLD_WIDTH}d" $((COLD_SET - 1)))")"
  { [ "$first_code" = 200 ] && [ "$last_code" = 200 ]; } || { echo "ERROR: cold-set bounds not both 200 (first=$first_code last=$last_code) — churn would hit 404s, invalidating the cold-read workload" >&2; cat "$RESULTS/${config}-server.log" >&2; exit 1; }
  echo ">> [$config] seed complete (hot=200, cold=${COLD_SET}, churn-bounds=200/200)."

  # --- warm the read cache for hot-read (a few GETs before measuring) ---
  for _ in 1 2 3 4 5; do curl -s -o /dev/null "${base}bench/hot"; done

  # --- workloads ---
  run_get_fixed "$config" "hot-read"  "${base}bench/hot"
  run_get_churn "$config" "cold-read" "${base}bench/cold/"
  # Reset the write area so the write workload starts clean + comparable per config.
  curl -s -o /dev/null -X DELETE "${base}bench/write/" 2>/dev/null || true
  curl -s -o /dev/null -X PUT -H 'content-type: text/turtle' "${base}bench/write/" || true
  run_put_churn "$config" "write" "${base}bench/write/"
  if [ "$RUN_MIXED" = 1 ]; then run_mixed "$config" "$base"; fi

  # --- teardown (SIGINT so CSS finalizes/flushes the write-back queue cleanly) ---
  kill -INT "$server_pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$server_pid" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  trap - EXIT INT TERM
  echo ">> [$config] done + shut down."
}

# Seed COLD_SET distinct resources via parallel curl (xargs -P). Bodies are tiny; this is a one-time
# fixture cost, not measured.
seed_cold() { # $1=base
  local base="$1"
  local body; body="$(printf 'x%.0s' $(seq 1 "$BODY_BYTES"))"
  # Pad to COLD_WIDTH so the names match the churn regex res-[0-9]{COLD_WIDTH} EXACTLY.
  seq 0 $((COLD_SET - 1)) | xargs -P 16 -I{} sh -c \
    'n=$(printf "%0'"${COLD_WIDTH}"'d" "$1"); curl -s -o /dev/null -X PUT -H "content-type: text/plain" -d "'"$body"'" "'"${base}"'bench/cold/res-${n}"' _ {}
}

# Optional 80/20 mixed read/write under one sweep, driven by two oha invocations is awkward; instead we
# approximate by running a churn GET against the cold set AND noting it (the dedicated hot/cold/write
# numbers already isolate each path). Kept simple + clearly labelled.
run_mixed() { # $1=config $2=base
  local config="$1" base="$2"
  echo ">> [$config] mixed: (approximated by cold-read churn over the seeded set — see SERVER-BENCH.md)"
  run_get_churn "$config" "mixed-read" "${base}bench/cold/"
}

# --- run all three configs back-to-back --------------------------------------------------------
echo ">> Machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')"
echo ">> CSS version: $CSS_VERSION   |   oha: $OHA_VERSION   |   runtime: $RUNTIME"
echo ">> Sweep: concurrency [$CONCURRENCY], duration $DURATION/level, warm-up $WARMUP_DURATION, body ${BODY_BYTES}B, cold-set ${COLD_SET}"
echo ">> Load context BEFORE run: $(uptime)"

# QUIET-BOX GUARD: the load-bearing fix. Block until the box is quiet so A/B/C run back-to-back inside
# ONE calm window and share conditions. (Set BENCH_SKIP_LOAD_GUARD=1 only to bypass deliberately.)
printf 'config\tone_min_load\tuptime\n' > "$RESULTS/load-context.tsv"
if [ "${BENCH_SKIP_LOAD_GUARD:-0}" = 1 ]; then
  echo ">> QUIET-BOX GUARD: BYPASSED (BENCH_SKIP_LOAD_GUARD=1) — numbers may be load-contaminated."
else
  wait_for_quiet_box
fi

bench_config "A-cached-file" "$HERE/server-configs/A-cached-file.json" "$PORT_A"
bench_config "B-plain-file"  "$HERE/server-configs/B-plain-file.json"  "$PORT_B"
bench_config "C-in-memory"   "$HERE/server-configs/C-in-memory.json"   "$PORT_C"

echo ""
echo ">> Load context AFTER run: $(uptime)"
echo ""
echo ">> DONE. Raw per-level JSON in $RESULTS/, summary table:"
echo ""
column -t -s $'\t' "$RESULTS_TSV"
echo ""
echo ">> Now regenerate perf/SERVER-BENCH.md from $RESULTS_TSV (the harness prints; the write-up is by hand with the load caveat)."
