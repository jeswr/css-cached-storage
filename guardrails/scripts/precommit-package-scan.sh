#!/usr/bin/env bash
# Wrapper so pre-commit can pass N changed package.json paths; runs the offline policy
# check (deny/allowlist) on each. CI runs the full online check (existence + age) separately.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fail=0
for f in "$@"; do
  node "$here/check-packages.mjs" --mode policy --scan "$f" || fail=1
done
exit "$fail"
