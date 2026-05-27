/**
 * dependency-cruiser — deterministic import/architecture allowlist ("fitness function").
 * Run: npx depcruise --config guardrails/dependency-cruiser.cjs src
 * Complements package-policy.json (which governs WHICH packages may be installed); this
 * governs HOW modules may import each other. Both are gates, not prose.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are a common agent-introduced defect.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Orphan modules are often agent-left cruft.",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)tsconfig\\.json$"] },
      to: {},
    },
    {
      name: "not-to-deprecated-core",
      severity: "error",
      comment: "Don't import deprecated Node core (e.g. 'punycode').",
      from: {},
      to: { dependencyTypes: ["core"], path: ["^(punycode|domain|sys)$"] },
    },
    {
      name: "no-banned-runtime-deps",
      severity: "error",
      comment: "Keep in sync with package-policy.json deny list.",
      from: {},
      to: {
        dependencyTypes: ["npm"],
        path: ["^(request|moment|node-fetch)($|/)"],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
