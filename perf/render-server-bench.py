#!/usr/bin/env python3
# AUTHORED-BY Claude Opus 4.8
#
# Render the markdown result tables + A-vs-B / A-vs-C deltas for perf/SERVER-BENCH.md from the
# harness's server-results/results.tsv. The harness produces the raw data; this turns it into the
# tables pasted into the write-up (so the numbers in the doc are mechanically faithful to the run).
#
# Usage: python3 perf/render-server-bench.py [perf/server-results/results.tsv]
import csv
import sys

tsv = sys.argv[1] if len(sys.argv) > 1 else "perf/server-results/results.tsv"
rows = []
with open(tsv) as f:
    for r in csv.DictReader(f, delimiter="\t"):
        rows.append(r)

# index[(config, workload, conc)] = row
idx = {(r["config"], r["workload"], r["concurrency"]): r for r in rows}
configs = ["A-cached-file", "B-plain-file", "C-in-memory"]
workloads = []
for r in rows:
    if r["workload"] not in workloads:
        workloads.append(r["workload"])
concs = []
for r in rows:
    if r["concurrency"] not in concs:
        concs.append(r["concurrency"])
concs.sort(key=int)


def g(config, workload, conc, col):
    r = idx.get((config, workload, conc))
    return float(r[col]) if r else None


def pct(new, base):
    if new is None or base is None or base == 0:
        return "—"
    d = (new - base) / base * 100.0
    return f"{'+' if d >= 0 else ''}{d:.0f}%"


def ratio(a, c):
    # how close A gets to the C ceiling, as a % of C's RPS
    if a is None or c is None or c == 0:
        return "—"
    return f"{a / c * 100.0:.0f}%"


print("Generated tables (paste into SERVER-BENCH.md):\n")

for w in workloads:
    print(f"### Workload: {w}\n")
    print("| concurrency | A RPS | B RPS | C RPS | A p50 | B p50 | C p50 | A p99 | B p99 | C p99 |")
    print("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for c in concs:
        cells = [c]
        for col in ("rps",):
            for cfg in configs:
                v = g(cfg, w, c, col)
                cells.append(f"{v:,.0f}" if v is not None else "—")
        for col in ("p50_ms", "p99_ms"):
            for cfg in configs:
                v = g(cfg, w, c, col)
                cells.append(f"{v:.2f}" if v is not None else "—")
        print("| " + " | ".join(str(x) for x in cells) + " |")
    print()
    # Delta table for this workload (RPS-based)
    print(
        f"**Deltas ({w}, RPS):** A-vs-B = cache benefit over plain file; "
        "A-vs-C = A as % of the in-memory ceiling.\n"
    )
    print("| concurrency | A RPS | B RPS | A-vs-B Δ | C RPS | A as % of C |")
    print("|---:|---:|---:|---:|---:|---:|")
    for c in concs:
        a = g("A-cached-file", w, c, "rps")
        b = g("B-plain-file", w, c, "rps")
        cc = g("C-in-memory", w, c, "rps")
        print(f"| {c} | {a:,.0f} | {b:,.0f} | {pct(a, b)} | {cc:,.0f} | {ratio(a, cc)} |")
    print()
