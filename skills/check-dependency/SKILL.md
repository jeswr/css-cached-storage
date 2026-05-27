---
name: check-dependency
description: Verify a package is real, approved, and not suspiciously new before adding it. Use whenever you are about to add or suggest a new npm or PyPI dependency, to avoid hallucinated/slopsquatted packages and banned libraries.
---

# Check a dependency before adding it

LLMs invent package names (~20% of suggestions in one study; the same fake name recurs
predictably, which attackers exploit — "slopsquatting"). Never add a package on faith.

## Steps

1. Run the guardrail:
   ```bash
   node guardrails/scripts/check-packages.mjs --ecosystem <npm|pypi> <name>
   ```
   It fails if the package is on the denylist, does not exist in the registry, or was first
   published more recently than the policy's `minAgeDays`.
2. If it fails because the package **doesn't exist**: you likely hallucinated the name. Find
   the real package (check its homepage/repo) or use an approved alternative.
3. If it fails because it's **banned**: use the suggested replacement in
   `guardrails/package-policy.json` → `denyReasons`.
4. If it fails because it's **too new**: treat as suspicious; confirm provenance before use.
5. Prefer a library already on the allowlist; only introduce a new dependency when no
   approved one fits, and add it to `package-policy.json` deliberately.
