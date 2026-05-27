# Agent instructions (Ruler source of truth)

This file is the single editable source. `ruler apply` compiles it into every tool's
native format (AGENTS.md, CLAUDE.md, .cursor/rules, .github/copilot-instructions.md,
Codex, Gemini, Aider…), so one edit propagates everywhere — the portable rules layer.
Keep it short: long instruction files measurably reduce task success (see docs/principles.md).

## Operating rules
1. The deterministic gates are the contract. Before finishing, run and fix:
   `pre-commit run --all-files --config guardrails/.pre-commit-config.yaml`, plus the
   relevant `ruff` / `biome` / tests. Never declare done with a gate red; never disable a
   gate to pass — if a gate is wrong, say so and propose the fix.
2. Never invent a dependency. Verify before adding:
   `node guardrails/scripts/check-packages.mjs --ecosystem <npm|pypi> <name>`. Prefer an
   approved library over reinventing; extract shared logic on its second occurrence.
3. Use the right tool for the task (Python for data/RDF/tooling, TS for app/pod code,
   Rust/Noir where chosen) — not reflexive TypeScript.
4. Look up real APIs (context7 MCP); never silence "method does not exist" with a cast.
5. Plan before non-trivial work; scale ceremony to the change. A human is accountable for
   every committed line — don't commit code you can't explain.

## Conventions (judgment; lintable rules live in the linters)
- Libraries over reinvention; flag code that reinvents a maintained library.
- No placeholder/minted IRIs — blank nodes or real dereferenceable URLs only.
- Match surrounding code's idiom; route security-critical parsing/config through vetted
  wrappers, never string-concat.

## Model routing
Use gateway tiers, not hardcoded models: plan→strong, execute→mid, format→cheap. Point
tools at the gateway via ANTHROPIC_BASE_URL / OPENAI_BASE_URL (see gateway/).
