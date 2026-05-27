---
name: verify-before-finishing
description: Run the deterministic gate stack and fix every failure before declaring any code change done. Use after editing code and before committing or reporting a task complete.
---

# Verify before finishing

A change is not done until the gates are green. The gates — not prose, not your own
judgement, not another model's review — are the contract. Run them and fix what they find.

## Steps

1. **Format + lint the languages you touched**
   - Python: `ruff check --fix && ruff format`
   - TS/JS: `npx @biomejs/biome check --write`
2. **Secrets**: ensure nothing secret was added (gitleaks runs in pre-commit/CI).
3. **Dependencies**: if you added any, verify each exists, isn't banned, isn't suspiciously
   new: `node guardrails/scripts/check-packages.mjs --ecosystem <npm|pypi> <name>`.
4. **Tests**: run the tests for the area you changed; add property-based tests for new
   logic where it makes sense.
5. **Run the whole stack**:
   `pre-commit run --all-files --config guardrails/.pre-commit-config.yaml`
6. If a gate fails, fix the code. If you believe the gate itself is wrong, say so
   explicitly and propose the fix — do **not** disable, skip, or weaken a gate to get green.

## Done means

All gates pass, tests pass, and you can explain every line you changed to a human.
