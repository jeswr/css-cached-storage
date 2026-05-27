import type { RepresentationMetadata } from "@solid/community-server";
import { LRUCache } from "lru-cache";

/**
 * A single cached resource. Data and metadata are populated independently:
 * `getData` fills `data` (+ `dataSize`), `getMetadata` fills `metadata`.
 */
interface CachedEntry {
  data?: Buffer[];
  dataSize: number;
  metadata?: RepresentationMetadata;
}

/**
 * A bounded, least-recently-used mirror of the source's *clean* reads.
 *
 * Only ever holds resources for which no write/delete is pending — the
 * {@link WriteQueue} overlay is authoritative for anything dirty, so the cache
 * can never serve a value that contradicts a queued mutation. Total retained
 * data bytes are capped by `maxCacheSize`; an individual resource larger than
 * `maxFileSize` is never admitted.
 */
export class ReadCache {
  private readonly cache: LRUCache<string, CachedEntry>;
  public readonly maxFileSize: number;

  public constructor(maxCacheSize: number, maxFileSize: number) {
    this.maxFileSize = maxFileSize;
    this.cache = new LRUCache<string, CachedEntry>({
      maxSize: Math.max(1, maxCacheSize),
      // Data bytes dominate; metadata-only entries count as 1 so they still age out.
      sizeCalculation: (entry): number => Math.max(1, entry.dataSize),
    });
  }

  /** Returns the cached entry for a path, or `undefined` on a miss. */
  public get(path: string): CachedEntry | undefined {
    return this.cache.get(path);
  }

  /**
   * Caches the data (and the metadata it was read with, if any) for a path.
   * No-op when the body is larger than `maxFileSize`; the path is also evicted
   * in that case so a stale smaller value cannot linger.
   */
  public setData(
    path: string,
    data: Buffer[],
    dataSize: number,
    metadata?: RepresentationMetadata,
  ): void {
    if (dataSize > this.maxFileSize) {
      this.cache.delete(path);
      return;
    }
    const existing = this.cache.get(path);
    this.cache.set(
      path,
      {
        data,
        dataSize,
        metadata: metadata ?? existing?.metadata,
      },
      { size: Math.max(1, dataSize) },
    );
  }

  /** Caches metadata for a path, preserving any already-cached data. */
  public setMetadata(path: string, metadata: RepresentationMetadata): void {
    const existing = this.cache.get(path);
    this.cache.set(
      path,
      {
        data: existing?.data,
        dataSize: existing?.dataSize ?? 0,
        metadata,
      },
      { size: Math.max(1, existing?.dataSize ?? 0) },
    );
  }

  /** Removes a path from the cache. Safe to call when absent. */
  public delete(path: string): void {
    this.cache.delete(path);
  }

  /** Empties the cache. */
  public clear(): void {
    this.cache.clear();
  }
}
