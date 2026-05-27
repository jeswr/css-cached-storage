# Performance evaluation

Compares stock CSS file storage against the same backend fronted by
`CachingDataAccessor`, on **authentication**, **resource reads**, and **resource
writes**, both sequentially and under concurrent load.

## How to run

```bash
bash perf/setup.sh          # build + pack + install an out-of-repo CSS runtime
node perf/bench.mjs         # boots each config, runs the workload, prints a table
```

`perf/setup.sh` installs CSS + this component into `/tmp/ccs-cache-perf-runtime`
(**outside** the repo — Components.js scans `node_modules` by walking up from the
main module, so an in-repo runtime would pull in dev-tooling component metadata
and fail to boot). `perf/bench.mjs` then boots each config in turn on a throwaway
data dir, authenticates with the CSS **client-credentials + DPoP** flow (via
`jose` — no `@inrupt`), and measures each phase.

Configs: [`configs/file.json`](configs/file.json) (baseline) and
[`configs/cached.json`](configs/cached.json), which `Override`s the backend
store's accessor to `CachingDataAccessor` wrapping the file accessor.

## Results

Median of **3 runs**, localhost, Apple Silicon, 256-byte resources. Latency in
ms (lower is better); throughput in ops/s (higher is better).

| phase                         | baseline | cached |       Δ |
| ----------------------------- | -------: | -----: | ------: |
| **auth** seq p50              |     32.2 |   21.1 | **−34%** |
| auth seq p95                  |     40.5 |   32.7 |   −19%  |
| **write** seq p50             |     30.8 |   21.4 | **−31%** |
| write seq p95                 |     73.6 |   41.2 |   −44%  |
| **read** seq p50              |     20.8 |   13.9 | **−33%** |
| read seq p95                  |     41.3 |   24.1 |   −42%  |
| auth under load, throughput   |     63.6 |   78.6 | **+24%** |
| mixed read/write load, p50    |    328.8 |  122.5 |   −63%  |
| mixed read/write load, thrpt  |     84.9 |  120.8 | **+42%** |

Load = 40 concurrent clients, 1500 mixed ops (80% read / 20% write); auth-load =
20 concurrent clients, 200 token exchanges.

## Interpretation

- **Writes** are faster because the queue acknowledges them in memory (write-back)
  and flushes to disk in the background, off the request path.
- **Reads** are faster because recently-read bodies are served from memory instead
  of re-read + re-parsed from disk.
- **Auth** benefits too: the client-credentials flow reads account/credential
  records through the same backend, so those reads hit the cache — most visible
  under concurrent load (**+24%** token throughput), where disk contention bites.
- **Mixed load** is where the cache helps most: **+42%** throughput and **−63%**
  median latency, as the read cache absorbs reads and the write queue removes the
  synchronous disk write from the hot path.

### Caveats

- Single loaded dev machine, localhost (no network latency), small resources — so
  per-request DPoP verification + HTTP framing dominate absolute latency, and the
  storage delta is a *fraction* of each number. The **deltas**, not the absolute
  ms, are the takeaway.
- Means were noticeably noisier than medians: the cached config showed occasional
  tail spikes (background-flush mutex contention + GC of buffered bodies), so this
  report uses **medians across 3 runs**. Tail latency (p95/p99) under heavy write
  bursts is the cache's weak spot and the main thing to watch in production.
- Write-back trades durability for speed: a hard crash loses the un-flushed queue
  (see the top-level README).

### Bonus: the benchmark caught a real bug

Booting CSS against `FileDataAccessor` (rather than the `InMemoryDataAccessor`
used in unit tests) surfaced a correctness bug: the decorator was setting
`posix:size` on write metadata, which the file accessor *also* sets, producing a
duplicate triple that corrupted the WebID profile document and broke
authentication. Fixed by leaving `posix:size` to the leaf accessor; covered by a
regression test.
