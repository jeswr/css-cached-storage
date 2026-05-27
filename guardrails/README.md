# Guardrails — the deterministic gate stack

The trustworthy-code layer. Everything here is a pass/fail check an auditor can re-run; none
of it is prose or an LLM judging an LLM. Run order, cheap→deep:

| Gate | Tool | Catches | Where |
|---|---|---|---|
| secrets | `gitleaks` (`.gitleaks.toml`) | keys/tokens, incl. ones an agent pasted | pre-commit + CI |
| naming / style / common errors | `ruff` (Py, `ruff.toml`), Biome (TS, `biome.json`) | the stuff that does NOT belong in a prose rule | pre-commit + CI |
| banned / unapproved deps | `package-policy.json` + `check-packages.mjs --mode policy` | denylisted or non-allowlisted packages | pre-commit (offline) |
| hallucinated / too-new deps | `check-packages.mjs` (full) | slopsquatting: non-existent or freshly-registered names | CI (online) |
| import / architecture rules | `dependency-cruiser.cjs` | cycles, banned imports, orphan cruft | CI |
| (next) tests → PBT → mutation → Lean/Noir proof | vitest/pytest, fast-check/Hypothesis, Stryker/mutmut, `lake build` | regressions → edge cases → weak tests → spec violations | CI |

## Run

```bash
pre-commit install --config guardrails/.pre-commit-config.yaml   # gate every commit
bash tests/selftest.sh                                           # prove gates catch bad input
node guardrails/scripts/check-packages.mjs --ecosystem npm <pkg> # check one package
```

`package-policy.json` is the single source of truth for dependency policy — edit it, don't
scatter "never use X" across prompt files. Switch `"mode": "allowlist"` to block everything
not explicitly approved.

## Adopt next (verified on GitHub, 2026-05-25 — need accounts/builds, not wired overnight)

These came out of the deep GitHub trawl as the maintained, high-adoption pieces worth adding:

| Project | Stars | Role | Why |
|---|---|---|---|
| [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) | ~4.1k | FS + network egress sandbox | Deterministic floor under any agent; portable. Highest-leverage addition. |
| [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway) | ~2.9k | MCP/tool-call firewall | Mediate every tool call with allow/deny + audit (Linux Foundation). |
| [invariantlabs-ai/mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) | ~2.5k | MCP-server safety scanner | CI gate deciding which MCP servers/skills are safe to allow. |
| [Socket](https://github.com/SocketDev/socket-cli) (+ GitHub App) | — | supply-chain gate | The only mature slopsquatting/malicious-dep gate; blocks too-new/sketchy deps on PRs. Complements `check-packages.mjs`. |
| [haydenbleasel/ultracite](https://github.com/haydenbleasel/ultracite) | ~3.0k | zero-config strict TS lint preset | Drop-in replacement for the hand-rolled `biome.json` for TS-heavy repos. |
| [sverweij/dependency-cruiser](https://github.com/sverweij/dependency-cruiser) | ~6.7k | import allowlist | Already configured here (`dependency-cruiser.cjs`); run `npx depcruise`. |

Concept anchors (peer-reviewed): **AgentSpec** (ICSE'26 — runtime interception blocks unsafe
actions, 90%+) and **ContextCov** (derives executable checks from AGENTS.md). Track for public
release.
