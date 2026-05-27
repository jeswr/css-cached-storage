/**
 * Performance comparison: stock CSS file backend vs. the same backend fronted by
 * CachingDataAccessor. Measures authentication, resource reads, and resource
 * writes, both sequentially and under concurrent load, against a freshly-booted
 * server for each configuration.
 *
 * Auth uses the CSS client-credentials + DPoP flow (jose only — no @inrupt).
 *
 * Usage: node perf/bench.mjs
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const jose = await import("jose");

// The CSS runtime (CSS + this component) lives outside the repo — see perf/setup.sh.
const RUNTIME = process.env.CCS_PERF_RUNTIME ?? "/tmp/ccs-cache-perf-runtime";
const REPO = resolve(import.meta.dirname, "..");

const SCENARIOS = [
  {
    label: "file (baseline)",
    config: join(REPO, "perf/configs/file.json"),
    port: 3010,
  },
  {
    label: "cached",
    config: join(REPO, "perf/configs/cached.json"),
    port: 3011,
  },
];

// Workload sizes — moderate, to exercise the caches without hammering the host.
const AUTH_ITERS = 25;
const WRITE_N = 150;
const BODY_BYTES = 256;
const READ_SET = 50;
const READ_REPEAT = 10;
const LOAD_CONCURRENCY = 40;
const LOAD_OPS = 1500;
const LOAD_READ_RATIO = 0.8;
const AUTH_LOAD_CONCURRENCY = 20;
const AUTH_LOAD_OPS = 200;

const now = () => performance.now();

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = sorted.reduce((t, v) => t + v, 0) / sorted.length;
  return { n: sorted.length, mean, p50: at(50), p95: at(95), p99: at(99) };
}

async function makeDpopSigner() {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256");
  const jwk = await jose.exportJWK(publicKey);
  return async (htu, htm) =>
    new jose.SignJWT({ htu, htm })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk })
      .setIssuedAt()
      .setJti(randomUUID())
      .sign(privateKey);
}

async function register(baseUrl, user) {
  let res = await fetch(new URL(".account/", baseUrl));
  let { controls } = await res.json();

  res = await fetch(controls.account.create, { method: "POST" });
  if (res.status !== 200)
    throw new Error(`account create: ${await res.text()}`);
  const authorization = `CSS-Account-Token ${(await res.json()).authorization}`;

  res = await fetch(controls.main.index, { headers: { authorization } });
  ({ controls } = await res.json());

  res = await fetch(controls.password.create, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (res.status !== 200) throw new Error(`login create: ${await res.text()}`);

  res = await fetch(controls.account.pod, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: user.podName }),
  });
  if (res.status !== 200) throw new Error(`pod create: ${await res.text()}`);
  const { webId } = await res.json();

  res = await fetch(new URL(".account/", baseUrl), {
    headers: { authorization },
  });
  ({ controls } = await res.json());
  res = await fetch(controls.account.clientCredentials, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ name: "bench", webId }),
  });
  if (res.status !== 200) throw new Error(`credentials: ${await res.text()}`);
  const { id, secret } = await res.json();

  return { webId, id, secret };
}

async function getToken(baseUrl, id, secret, dpop) {
  const oidc = await (
    await fetch(new URL(".well-known/openid-configuration", baseUrl))
  ).json();
  const tokenUrl = oidc.token_endpoint;
  const basic = Buffer.from(
    `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`,
  ).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await dpop(tokenUrl, "POST"),
    },
    body: "grant_type=client_credentials&scope=webid",
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function authedFetch(token, dpop) {
  return async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const headers = {
      ...(opts.headers ?? {}),
      authorization: `DPoP ${token}`,
      dpop: await dpop(url, method),
    };
    const res = await fetch(url, { ...opts, headers });
    // Drain the body so the socket frees up for the next request.
    await res.arrayBuffer();
    return res;
  };
}

async function bootServer(config, port) {
  const baseUrl = `http://localhost:${port}/`;
  const dataDir = `/tmp/ccs-perf-${port}`;
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const bin = join(
    REPO,
    "node_modules",
    "@solid",
    "community-server",
    "bin",
    "server.js",
  );
  const child = spawn(
    process.execPath,
    [
      bin,
      "-c",
      config,
      "-m",
      RUNTIME,
      "-f",
      dataDir,
      "-p",
      String(port),
      "-b",
      baseUrl,
      "-l",
      "warn",
    ],
    { stdio: ["ignore", "ignore", "pipe"], cwd: RUNTIME },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null)
      throw new Error(`server exited early:\n${stderr}`);
    try {
      const res = await fetch(baseUrl);
      if (res.status) return { child, baseUrl };
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start:\n${stderr}`);
}

async function shutdown(child) {
  child.kill("SIGINT");
  await Promise.race([once(child, "exit"), sleep(8000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runPool(concurrency, total, task) {
  const samples = [];
  let issued = 0;
  const worker = async () => {
    while (issued < total) {
      const index = issued++;
      const t0 = now();
      await task(index);
      samples.push(now() - t0);
    }
  };
  const wall0 = now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { samples, throughput: (total / (now() - wall0)) * 1000 };
}

async function benchmark(scenario) {
  const { child, baseUrl } = await bootServer(scenario.config, scenario.port);
  try {
    const cred = await register(baseUrl, {
      email: "alice@example.com",
      password: "secret",
      podName: "alice",
    });
    const pod = `${baseUrl}alice/`;
    const body = "x".repeat(BODY_BYTES);

    const dpop = await makeDpopSigner();
    const token = await getToken(baseUrl, cred.id, cred.secret, dpop);
    const af = authedFetch(token, dpop);

    // Warm-up (not measured): create the read set + prime any per-process state.
    for (let i = 0; i < READ_SET; i++) {
      const res = await af(`${pod}warm-${i}`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
      });
      if (!res.ok) throw new Error(`warmup PUT ${res.status}`);
    }

    // Sequential auth latency (fresh key + token each time).
    const authSeq = [];
    for (let i = 0; i < AUTH_ITERS; i++) {
      const d = await makeDpopSigner();
      const t0 = now();
      await getToken(baseUrl, cred.id, cred.secret, d);
      authSeq.push(now() - t0);
    }

    // Sequential write latency.
    const writeSeq = [];
    for (let i = 0; i < WRITE_N; i++) {
      const t0 = now();
      const res = await af(`${pod}res-${i}`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
      });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
      writeSeq.push(now() - t0);
    }

    // Sequential repeated reads (exercises the read cache for the cached config).
    const readSeq = [];
    for (let r = 0; r < READ_REPEAT; r++) {
      for (let i = 0; i < READ_SET; i++) {
        const t0 = now();
        const res = await af(`${pod}warm-${i}`);
        if (!res.ok) throw new Error(`GET ${res.status}`);
        readSeq.push(now() - t0);
      }
    }

    // Concurrent auth.
    const authLoad = await runPool(
      AUTH_LOAD_CONCURRENCY,
      AUTH_LOAD_OPS,
      async () => {
        const d = await makeDpopSigner();
        await getToken(baseUrl, cred.id, cred.secret, d);
      },
    );

    // Mixed read/write under load.
    const mixedLoad = await runPool(LOAD_CONCURRENCY, LOAD_OPS, async (i) => {
      if (Math.random() < LOAD_READ_RATIO) {
        const res = await af(`${pod}warm-${i % READ_SET}`);
        if (!res.ok) throw new Error(`load GET ${res.status}`);
      } else {
        const res = await af(`${pod}load-${i}`, {
          method: "PUT",
          headers: { "content-type": "text/plain" },
          body,
        });
        if (!res.ok) throw new Error(`load PUT ${res.status}`);
      }
    });

    return {
      label: scenario.label,
      authSeq: summarize(authSeq),
      writeSeq: summarize(writeSeq),
      readSeq: summarize(readSeq),
      authLoad: {
        ...summarize(authLoad.samples),
        throughput: authLoad.throughput,
      },
      mixedLoad: {
        ...summarize(mixedLoad.samples),
        throughput: mixedLoad.throughput,
      },
    };
  } finally {
    await shutdown(child);
  }
}

function row(name, a, b, key, unit) {
  const av = a[key];
  const bv = b[key];
  const delta = ((bv - av) / av) * 100;
  const fmt = (v) => (unit === "ops/s" ? v.toFixed(0) : v.toFixed(2));
  return `| ${name.padEnd(26)} | ${fmt(av).padStart(10)} | ${fmt(bv).padStart(10)} | ${`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`.padStart(8)} |`;
}

async function main() {
  const results = {};
  for (const scenario of SCENARIOS) {
    process.stderr.write(`\n=== ${scenario.label} ===\n`);
    results[scenario.label] = await benchmark(scenario);
    process.stderr.write(`done: ${scenario.label}\n`);
  }

  const a = results["file (baseline)"];
  const b = results.cached;
  const lines = [
    "",
    `Latency = ms (lower better). Throughput = ops/s (higher better). Δ = cached vs baseline.`,
    "",
    `| metric                     |   baseline |     cached |        Δ |`,
    `| -------------------------- | ---------- | ---------- | -------- |`,
    row("auth seq p50", a.authSeq, b.authSeq, "p50"),
    row("auth seq p95", a.authSeq, b.authSeq, "p95"),
    row("write seq p50", a.writeSeq, b.writeSeq, "p50"),
    row("write seq p95", a.writeSeq, b.writeSeq, "p95"),
    row("read seq p50", a.readSeq, b.readSeq, "p50"),
    row("read seq p95", a.readSeq, b.readSeq, "p95"),
    row("auth load p95", a.authLoad, b.authLoad, "p95"),
    row("auth load throughput", a.authLoad, b.authLoad, "throughput", "ops/s"),
    row("mixed load p95", a.mixedLoad, b.mixedLoad, "p95"),
    row(
      "mixed load throughput",
      a.mixedLoad,
      b.mixedLoad,
      "throughput",
      "ops/s",
    ),
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
