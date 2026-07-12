#!/usr/bin/env node
/**
 * check-packages.mjs — deterministic dependency guardrail.
 *
 * Enforces three things against npm / PyPI, with no third-party dependencies:
 *   1. policy   — package is not on the denylist (and, in allowlist mode, IS on the allowlist)
 *   2. existence — package actually exists in the registry  (defends against hallucinated
 *                  / "slopsquatted" names: USENIX Security 2025 — ~20% of LLM-suggested
 *                  packages don't exist, and the same fake name recurs predictably)
 *   3. age       — package's FIRST publication is at least `minAgeDays` old (a freshly
 *                  registered name matching a hallucination is the attack signature)
 *
 * Modes:
 *   --mode policy   offline; checks deny/allow lists only (fast — use in pre-commit)
 *   --mode full     online; policy + existence + age            (use in CI)
 *
 * Inputs:
 *   <name>...            explicit package names
 *   --scan <path>        read deps from a package.json (npm) — names auto-extracted
 *   --ecosystem npm|pypi (default npm; inferred as npm when --scan is a package.json)
 *
 * Tuning:
 *   --policy <path>      path to package-policy.json (default: ../package-policy.json)
 *   --min-age-days <n>   override policy minAgeDays (lets CI/tests prove the gate fires)
 *   --strict             treat registry/network errors as failures (default: warn, pass)
 *
 * Exit code: 0 = all clear, 1 = at least one violation, 2 = usage error.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {
    names: [],
    mode: "full",
    ecosystem: "npm",
    strict: false,
    scan: null,
    policy: resolve(HERE, "..", "package-policy.json"),
    minAgeDays: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") o.mode = argv[++i];
    else if (a === "--ecosystem") o.ecosystem = argv[++i];
    else if (a === "--scan") o.scan = argv[++i];
    else if (a === "--policy") o.policy = argv[++i];
    else if (a === "--min-age-days") o.minAgeDays = Number(argv[++i]);
    else if (a === "--strict") o.strict = true;
    else if (a.startsWith("--")) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else o.names.push(a);
  }
  return o;
}

function loadPolicy(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`could not read policy ${path}: ${e.message}`);
    process.exit(2);
  }
}

function resolveNpmAlias(name, spec) {
  if (typeof spec !== "string" || !spec.startsWith("npm:")) return name;
  const target = spec.slice("npm:".length);
  const at = target.lastIndexOf("@");
  return at > 0 ? target.slice(0, at) : target;
}

function namesFromPackageJson(path) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const groups = [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ];
  return groups.flatMap((group) =>
    Object.entries(group ?? {}).map(([name, spec]) =>
      resolveNpmAlias(name, spec),
    ),
  );
}

// Returns { exists: bool, createdMs: number|null } or throws on network error.
async function registryInfo(ecosystem, name) {
  if (ecosystem === "npm") {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 404) return { exists: false, createdMs: null };
    if (!r.ok) throw new Error(`npm registry ${r.status}`);
    const j = await r.json();
    const created = j?.time?.created ? Date.parse(j.time.created) : null;
    return { exists: true, createdMs: created };
  }
  if (ecosystem === "pypi") {
    const r = await fetch(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
      { headers: { accept: "application/json" } },
    );
    if (r.status === 404) return { exists: false, createdMs: null };
    if (!r.ok) throw new Error(`pypi ${r.status}`);
    const j = await r.json();
    let earliest = null;
    for (const files of Object.values(j.releases ?? {}))
      for (const f of files) {
        const t = Date.parse(f.upload_time_iso_8601 ?? f.upload_time ?? "");
        if (!Number.isNaN(t) && (earliest === null || t < earliest))
          earliest = t;
      }
    return { exists: true, createdMs: earliest };
  }
  throw new Error(`unsupported ecosystem: ${ecosystem}`);
}

const o = parseArgs(process.argv.slice(2));
const policy = loadPolicy(o.policy);
const eco = o.scan?.endsWith("package.json") ? "npm" : o.ecosystem;
const minAge = o.minAgeDays ?? policy.minAgeDays ?? 0;
const ecoPolicy = policy[eco] ?? { deny: [], allow: [] };
const deny = new Set(ecoPolicy.deny ?? []);
const allow = new Set(ecoPolicy.allow ?? []);
const allowlistMode = (policy.mode ?? "denylist") === "allowlist";

let names = o.names.slice();
if (o.scan) names.push(...namesFromPackageJson(o.scan));
names = [...new Set(names)];
if (names.length === 0) {
  console.error("no package names given (pass names or --scan)");
  process.exit(2);
}

const violations = [];
const warnings = [];

for (const name of names) {
  // 1. policy (offline)
  if (deny.has(name)) {
    violations.push(`${name}: on DENYLIST (${eco})`);
    continue;
  }
  if (allowlistMode && !allow.has(name)) {
    violations.push(`${name}: not on ALLOWLIST (${eco}, allowlist mode)`);
    continue;
  }
  if (o.mode === "policy") {
    console.log(`ok(policy)   ${name}`);
    continue;
  }

  // 2 + 3. existence + age (online)
  try {
    const { exists, createdMs } = await registryInfo(eco, name);
    if (!exists) {
      violations.push(
        `${name}: DOES NOT EXIST in ${eco} — possible hallucination/slopsquat`,
      );
      continue;
    }
    if (createdMs == null) {
      warnings.push(
        `${name}: exists but publish date unknown — cannot age-check`,
      );
      console.log(`ok(exists)   ${name}`);
      continue;
    }
    const ageDays = Math.floor((Date.now() - createdMs) / 86_400_000);
    if (ageDays < minAge) {
      violations.push(
        `${name}: TOO NEW — first published ${ageDays}d ago (< ${minAge}d threshold)`,
      );
      continue;
    }
    console.log(`ok           ${name}  (age ${ageDays}d)`);
  } catch (e) {
    if (o.strict) {
      violations.push(
        `${name}: registry check failed (${e.message}) [--strict]`,
      );
    } else {
      warnings.push(
        `${name}: registry check failed (${e.message}) — passing (use --strict to fail)`,
      );
    }
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
if (violations.length) {
  console.error(`\nFAIL  ${violations.length} package policy violation(s):`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(
  `\nPASS  ${names.length} package(s) cleared (${o.mode} mode, ${eco}).`,
);
