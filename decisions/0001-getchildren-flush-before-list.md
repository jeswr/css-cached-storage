# 0001 — `getChildren` flushes the queue before listing

**Status:** accepted · **Date:** 2026-05-27 · **Mode:** autonomous

## Context

`getChildren(container)` must return a listing consistent with what `getData`/`getMetadata` return
for the same children. The source backing accessor does not know about mutations still sitting in
the write queue:

- a queued-but-unflushed **create** is missing from the source listing (false negative);
- a queued **delete** (tombstone) still appears in the source listing (false positive — a stale
  read).

So delegating straight to `source.getChildren` can produce a listing that contradicts the overlay.

## Decision

**Flush the write queue, then delegate to the source** (`await writeQueue.flushAll()` followed by
`yield* source.getChildren(identifier)`). After the flush the source is authoritative for the
container, so the listing is correct.

For simplicity v1 flushes the **whole** queue rather than only the target container's children;
listing is far rarer than data reads, and a scoped flush needs a parent-indexed view of pending ops
that we do not yet maintain.

## Why (over the alternative)

The alternative — **overlay-merge** — computes the listing in memory without flushing:

```
result = source children + pending creates (children of C) − pending deletes (children of C)
```

It keeps listings fast and never forces a flush, but needs more bookkeeping:

- an index of pending ops keyed by **parent container** (so "children of C" is O(children), not a
  full-map scan);
- synthesising metadata (`posix:size`, last-modified) for queued-but-unflushed children, since the
  source has not recorded it yet.

Overlay-merge is strictly an **optimisation** — same observable behaviour, no new correctness
guarantee. Flush-before-list is correct, small, and easy to test, so it ships first.

## Upgrade path (the documented "later")

1. Maintain `Map<parentPath, Set<childPath>>` alongside the pending map.
2. In `getChildren`, stream `source.getChildren`, drop entries with a pending delete, and append
   entries for pending creates with metadata synthesised from their `WriteOp`.
3. Keep flush-before-list available as a fallback / correctness oracle in tests.

## Consequences

- A `getChildren` call can block on (and trigger) source writes; under listing-heavy workloads this
  partially negates the write-back speed-up for that window.
- If the source cannot accept writes, `getChildren` surfaces the flush error rather than returning a
  possibly-inconsistent listing.
