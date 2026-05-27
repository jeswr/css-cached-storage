#!/usr/bin/env bash
# Self-test: prove each deterministic gate BLOCKS the bad fixtures and PASSES the good ones.
# Exit 0 only if every gate behaves. Used locally and in CI.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"

pass=0; fail=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
bad(){ echo "  FAIL  $1"; fail=$((fail+1)); }
# A gate is correct if it exits NONZERO on bad input and ZERO on good input.
expect_fail(){ d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d (gate did NOT catch bad input)"; else ok "$d"; fi; }
expect_pass(){ d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d (gate rejected good input)"; fi; }

echo "[ruff] python naming/errors"
if command -v ruff >/dev/null 2>&1; then
  expect_fail "blocks bad_naming.py"   ruff check tests/fixtures/bad/bad_naming.py
  expect_pass "passes good sample.py"  ruff check tests/fixtures/good/sample.py
else echo "  SKIP  ruff not installed"; fi

echo "[package-policy] deny/allow (offline)"
expect_fail "blocks bad package.json"  node guardrails/scripts/check-packages.mjs --mode policy --scan tests/fixtures/bad/package.json
expect_pass "passes good package.json" node guardrails/scripts/check-packages.mjs --mode policy --scan tests/fixtures/good/package.json

echo "[package-existence] slopsquat/age (online)"
expect_fail "blocks hallucinated npm pkg" node guardrails/scripts/check-packages.mjs --ecosystem npm totally-fake-pkg-zzz-9999-slop
expect_pass "passes real npm pkg"          node guardrails/scripts/check-packages.mjs --ecosystem npm react

echo "[gitleaks] secrets"
if command -v gitleaks >/dev/null 2>&1; then
  tb=$(mktemp -d); cp tests/fixtures/bad/leaked_secret.txt "$tb/"
  tg=$(mktemp -d); cp tests/fixtures/good/sample.py "$tg/"
  expect_fail "detects fake key in bad fixture" gitleaks detect --no-git --source "$tb" --no-banner
  expect_pass "clean on good fixture"           gitleaks detect --no-git --source "$tg" --no-banner
  rm -rf "$tb" "$tg"
else echo "  SKIP  gitleaks not installed"; fi

echo "[biome] TS naming (optional)"
if npx --yes @biomejs/biome --version >/dev/null 2>&1; then
  expect_fail "blocks bad_naming.ts"  npx --yes @biomejs/biome lint tests/fixtures/bad/bad_naming.ts
  expect_pass "passes good sample.ts" npx --yes @biomejs/biome lint tests/fixtures/good/sample.ts
else echo "  SKIP  biome unavailable"; fi

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
