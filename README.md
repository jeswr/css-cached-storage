# @jeswr/css-cached-storage

A [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) (CSS)
`DataAccessor` that puts an **in-memory read cache** and a **write-back queue** in front of
another `DataAccessor`, speeding up both reads and writes — without ever serving a stale read.

It is itself a `DataAccessor`, so it slots transparently between CSS's
`DataAccessorBasedStore` and any backing accessor (`FileDataAccessor`, `SparqlDataAccessor`,
`InMemoryDataAccessor`, …).

## How it works

```
DataAccessorBasedStore
        │
        ▼
CachingDataAccessor ──┬── read cache (LRU, clean mirror of the source)
                      └── write queue (pending writes/deletes, flushed in the background)
        │
        ▼
   source DataAccessor (file system, SPARQL, …)
```

- **Reads** check, in order: the **write queue** → the **read cache** → the **source**. A clean
  body read from the source is cached up to a per-file cap.
- **Writes** below the per-file cap are buffered and acknowledged immediately (write-back), then
  flushed to the source in order by a background worker. Larger bodies stream straight to the
  source.

### No stale reads

Every read consults the write queue **first**, so a pending write or delete is always reflected
before the read cache or source is touched. A path is never simultaneously *dirty* (in the queue)
and present in the read cache — there is one source of truth per path. Writes/deletes evict the
read-cache entry; a read that races a write re-checks the queue before caching.

This guarantee holds for **a single instance that is the sole writer to the source**. The class is
therefore marked `SingleThreaded`; clustered deployments would need a shared coherent cache, which
is out of scope here.

### Durability

The write queue is **write-back**: `writeDocument` returns before the data reaches the source.
Pending writes are drained on shutdown via CSS's `Finalizable.finalize()`, and an optional
`flushIntervalMs` adds a periodic safety-net flush. A **hard crash loses any un-flushed writes** —
this is the cost of the write speed-up. Set a small `maxWriteQueueSize` / `flushIntervalMs` to
bound the loss window.

### Scope notes (deliberate trade-offs)

- **`getChildren` flushes the queue, then lists** (correctness-first). See
  [`decisions/0001-getchildren-flush-before-list.md`](decisions/0001-getchildren-flush-before-list.md).
- **Container writes (`writeContainer`) are write-through**, not queued: containers are
  metadata-only and cheap, and this keeps directory-listing coherence simple.
- **Deletes are write-through** unless the resource only exists in the queue (then they tombstone),
  so a genuine `404` on a missing resource still propagates synchronously.

## Configuration

| Parameter               | Meaning                                                                   | Default  |
| ----------------------- | ------------------------------------------------------------------------- | -------- |
| `source`                | The wrapped `DataAccessor` (required).                                    | —        |
| `maxReadCacheSize`      | Total bytes of resource data the read cache may retain (LRU eviction).    | 100 MiB  |
| `maxReadFileSize`       | Largest single body admitted to the read cache; bigger reads stream through uncached. | 10 MiB |
| `maxWriteQueueSize`     | Total bytes of un-flushed writes before falling back to write-through.    | 100 MiB  |
| `maxWriteQueueFileSize` | Largest single body buffered; bigger writes bypass straight to the source. | 10 MiB  |
| `flushIntervalMs`       | Periodic safety-net flush interval (`0` disables; writes still flush eagerly). | `0` |

## Usage (Components.js)

This package ships a Components.js component and an example config. To use the cache in front of
the file backend, import [`config/caching-file.json`](config/caching-file.json) and point the
backend store's `accessor` at `urn:solid-server:default:CachedDataAccessor`:

```jsonc
{
  "@id": "urn:solid-server:default:ResourceStore_Backend",
  "@type": "DataAccessorBasedStore",
  "accessor": { "@id": "urn:solid-server:default:CachedDataAccessor" }
}
```

## Development

```bash
npm install
npm run build      # tsc + componentsjs-generator
npm test           # jest unit + integration
npm run lint       # biome
```

## Licence

MIT © Jesse Wright
