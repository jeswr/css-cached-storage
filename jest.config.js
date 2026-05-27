module.exports = {
  testEnvironment: "node",
  // Transpile-only (isolatedModules in tsconfig) keeps the suite fast; `tsc
  // --noEmit` in CI is the source of truth for types. See SLOW-COMMANDS.md.
  transform: {
    "^.+\\.ts$": ["ts-jest", {}],
  },
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage",
  // The decorator wraps streams, so give async assertions a little room.
  testTimeout: 15000,
};
