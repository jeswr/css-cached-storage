# AGENTS.md

Canonical agent instructions for this repo. Kept deliberately short — the evidence
(ETH AGENTbench 2026; "Lost in the Middle", TACL 2024) is that long instruction files
*reduce* task success and raise cost. **Anything checkable by a tool lives in the tool,
not here.** This file holds only non-inferable judgment and pointers to the gates.

`CLAUDE.md` is a symlink to this file. Per-project specifics go in that project's own
`AGENTS.md`, which overrides this one for its subtree.

## Operating rules

1. **The gates are the contract, not this file.** Before finishing any change, run the
   deterministic gates and fix every failure:
   - `pre-commit run --all-files --config guardrails/.pre-commit-config.yaml`
   - language checks: `ruff check` (Python), `npx @biomejs/biome check` (TS/JS)
   - tests for the area you touched.
   Do not declare work done while a gate is red. Do not disable a gate to make it pass;
   if a gate is wrong, say so explicitly and propose the fix.

2. **Never invent a dependency.** Before adding any package, verify it exists, is not
   banned, and is not suspiciously new:
   `node guardrails/scripts/check-packages.mjs --ecosystem <npm|pypi> <name>`.
   Prefer an already-approved library over writing it yourself or pulling a new one
   (second occurrence of the same logic → extract to a shared module, don't copy-paste).

3. **Use the right tool for the task, not reflexive TypeScript.** Python often wins for
   data/RDF/tooling; TS for app/pod-side code; Rust/Noir where chosen. Pick deliberately.

4. **Look up real APIs; don't guess.** When unsure of a library's API, consult its docs
   (context7 MCP) rather than guessing. Never silence a "method does not exist" error with
   a cast or `@ts-expect-error` — fix the call.

5. **Plan before non-trivial work; scale ceremony to the change.** Large/risky/multi-repo
   work: write a short plan + acceptance criteria, get human sign-off, then implement.
   Small/iterative work: just do it well. Don't generate 16 acceptance criteria for a
   one-line fix.

6. **A human is accountable for every committed line.** Don't commit code you can't
   explain. Surface uncertainty rather than papering over it.

## Conventions (the non-lintable judgment; lintable rules are in the linters)

- **Libraries over reinvention.** If a maintained library does it, use it; flag teammate
  code that reinvents (e.g. hand-rolled header parsing where `content-type` exists).
- **No placeholder/minted IRIs or URLs.** Use blank nodes or real, dereferenceable URLs
  (WebID/ORCID/ROR/W3C/GitHub). Never mint `https://id.example.org/...`-style IRIs that
  don't resolve.
- **Match surrounding code.** Comment density, naming, and idiom should look like the file
  you're editing.
- **Security-critical parsing/config goes through vetted wrappers**, never string-concat
  (e.g. access control, RDF) — use the dedicated mapper/library.

## What is enforced where (so you know where to look, not to restate it)

| Concern | Enforced by | Not by |
|---|---|---|
| Naming conventions | `ruff` (N rules) / Biome `useNamingConvention` | this file |
| Banned / unapproved packages | `guardrails/package-policy.json` + `check-packages` (pre-commit + CI) | this file |
| Hallucinated / too-new packages | `check-packages` registry+age gate (CI) | this file |
| Secrets in commits | `gitleaks` (pre-commit + CI) | this file |
| Style / common errors | `ruff`, Biome, type-checkers | this file |
| Workflow gates | branch protection + required CI + (optionally) Claude Code `Stop` hook | prose |

## Model routing (when this repo's tooling calls an LLM)

Use the gateway tiers, not a hardcoded model: **plan/architect → strong** (Opus/GPT-5),
**execute/edit → mid** (Sonnet/Codex/local), **format/summarize → cheap** (Haiku/local).
Point tools at the gateway via `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` (see `gateway/`).
