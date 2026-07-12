import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const GUARD = join(REPO_ROOT, "guardrails", "scripts", "check-packages.mjs");
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.NO_COLOR;

let dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function scan(manifest: object) {
  const dir = mkdtempSync(join(tmpdir(), "check-packages-guard-test-"));
  dirs.push(dir);
  const fixture = join(dir, "package.json");
  writeFileSync(fixture, JSON.stringify(manifest));
  return spawnSync(
    process.execPath,
    [GUARD, "--mode", "policy", "--scan", fixture],
    { encoding: "utf8", env: CHILD_ENV },
  );
}

describe("check-packages guard (policy mode, offline)", (): void => {
  it("catches a denylisted package in optionalDependencies", (): void => {
    const result = scan({ optionalDependencies: { request: "^2.88.0" } });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/request.*DENYLIST/);
  });

  it("catches a denylisted package behind an npm: alias", (): void => {
    const result = scan({
      dependencies: { "totally-safe-alias": "npm:request@^2.88.0" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/request.*DENYLIST/);
  });

  it("catches an npm: alias target in optionalDependencies", (): void => {
    const result = scan({
      optionalDependencies: { harmless: "npm:moment@^2.29.0" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/moment.*DENYLIST/);
  });

  it("preserves the scope when resolving npm: aliases", (): void => {
    const result = scan({
      dependencies: { biome: "npm:@biomejs/biome@^2.0.0" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/ok\(policy\)\s+@biomejs\/biome$/m);
    expect(result.stdout).not.toMatch(/ok\(policy\)\s+biome$/m);
  });

  it("does not flag this repo's root package.json", (): void => {
    const result = spawnSync(
      process.execPath,
      [GUARD, "--mode", "policy", "--scan", join(REPO_ROOT, "package.json")],
      { encoding: "utf8", env: CHILD_ENV },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
