import type { Readable } from "node:stream";
import {
  type DataAccessor,
  type Finalizable,
  type Guarded,
  guardedStreamFrom,
  isInternalContentType,
  NotFoundHttpError,
  POSIX,
  type Representation,
  RepresentationMetadata,
  type ResourceIdentifier,
  type SingleThreaded,
} from "@solid/community-server";
import { ReadCache } from "./cache/ReadCache";
import { WriteQueue } from "./cache/WriteQueue";
import { tappedReadable } from "./util/StreamUtil";

/**
 * Configuration for a {@link CachingDataAccessor}. All sizes are in bytes.
 */
export interface CachingDataAccessorArgs {
  /** The DataAccessor whose reads/writes are cached. */
  source: DataAccessor;
  /** Total bytes of resource data the read cache may retain (LRU eviction). Default 1 GiB. */
  maxReadCacheSize?: number;
  /** Largest single body admitted to the read cache; bigger reads stream through uncached. Default 1 MiB. */
  maxReadFileSize?: number;
  /** Total bytes of un-flushed writes the queue may hold before falling back to write-through. Default 100 MiB. */
  maxWriteQueueSize?: number;
  /** Largest single body buffered into the write queue; bigger writes bypass straight to the source. Default 10 MiB. */
  maxWriteQueueFileSize?: number;
  /** Optional interval (ms) for a periodic safety-net flush. 0 disables it (writes still flush eagerly). Default 0. */
  flushIntervalMs?: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * A {@link DataAccessor} that fronts another accessor with an in-memory read
 * cache and a write-back queue, to speed up both reads and writes.
 *
 * **No stale reads.** Every read consults the write queue first, so a pending
 * (un-flushed) write or delete is always reflected before the read cache or the
 * source is touched; a path is never simultaneously dirty *and* present in the
 * read cache. This holds only within a single instance with no other writer to
 * the source — hence {@link SingleThreaded}; clustered deployments need a shared
 * coherent cache, which is out of scope.
 *
 * **Writes** below `maxWriteQueueFileSize` are buffered and acknowledged
 * immediately (write-back), flushed in order by a background worker; larger
 * bodies stream straight to the source. Un-flushed writes are drained on
 * {@link finalize}; a hard crash loses them.
 */
export class CachingDataAccessor
  implements DataAccessor, SingleThreaded, Finalizable
{
  private readonly source: DataAccessor;
  private readonly readCache: ReadCache;
  private readonly writeQueue: WriteQueue;
  private readonly maxWriteQueueFileSize: number;
  private flushTimer: NodeJS.Timeout | undefined;

  public constructor(args: CachingDataAccessorArgs) {
    this.source = args.source;
    this.maxWriteQueueFileSize = args.maxWriteQueueFileSize ?? 10 * MIB;
    this.readCache = new ReadCache(
      args.maxReadCacheSize ?? GIB,
      args.maxReadFileSize ?? MIB,
    );
    this.writeQueue = new WriteQueue(
      args.source,
      args.maxWriteQueueSize ?? 100 * MIB,
    );

    const interval = args.flushIntervalMs ?? 0;
    if (interval > 0) {
      this.flushTimer = setInterval(
        (): void => this.writeQueue.kick(),
        interval,
      );
      this.flushTimer.unref();
    }
  }

  public async canHandle(representation: Representation): Promise<void> {
    return this.source.canHandle(representation);
  }

  public async getData(
    identifier: ResourceIdentifier,
  ): Promise<Guarded<Readable>> {
    const { path } = identifier;
    const op = this.writeQueue.peek(path);
    if (op?.type === "delete") {
      throw new NotFoundHttpError();
    }
    if (op?.type === "write") {
      return guardedStreamFrom(op.data);
    }
    const cached = this.readCache.get(path);
    if (cached?.data) {
      return guardedStreamFrom(cached.data);
    }
    // Clean path (no pending write/delete): read the source, caching as it
    // streams through.
    return this.readFromSource(identifier);
  }

  public async getMetadata(
    identifier: ResourceIdentifier,
  ): Promise<RepresentationMetadata> {
    const { path } = identifier;
    const op = this.writeQueue.peek(path);
    if (op?.type === "delete") {
      throw new NotFoundHttpError();
    }
    if (op?.type === "write") {
      // Reflect the size the leaf accessor will persist on flush, so a queued
      // write reads back the same posix:size before and after flushing. Only the
      // cache-visible copy gets it — op.metadata stays clean so the flush never
      // writes a duplicate posix:size triple.
      const metadata = new RepresentationMetadata(op.metadata);
      if (
        metadata.contentType &&
        !isInternalContentType(metadata.contentType)
      ) {
        metadata.set(POSIX.terms.size, `${op.size}`);
      }
      return metadata;
    }
    const cached = this.readCache.get(path);
    if (cached?.metadata) {
      return new RepresentationMetadata(cached.metadata);
    }
    const metadata = await this.source.getMetadata(identifier);
    // Re-check: only cache if still clean (a write may have raced in).
    if (!this.writeQueue.peek(path)) {
      this.readCache.setMetadata(path, metadata);
    }
    return new RepresentationMetadata(metadata);
  }

  public async *getChildren(
    identifier: ResourceIdentifier,
  ): AsyncIterableIterator<RepresentationMetadata> {
    // Approach A — flush-before-list: drain the queue so the source is
    // authoritative for this container, then delegate. Correct but forces a
    // flush on listing.
    // TODO(later): overlay-merge — yield (source children + pending creates −
    // pending deletes) without flushing. See
    // decisions/0001-getchildren-flush-before-list.md.
    await this.writeQueue.flushAll();
    yield* this.source.getChildren(identifier);
  }

  public async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const { path } = identifier;
    const iterator = data[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let size = 0;

    let next = await iterator.next();
    while (next.done !== true) {
      const chunk = Buffer.from(next.value as Buffer);
      chunks.push(chunk);
      size += chunk.length;
      if (size > this.maxWriteQueueFileSize) {
        // Too big to buffer: stream the prefix + the rest straight to the source.
        await this.writeQueue.bypassWrite(
          identifier,
          metadata,
          chunks,
          iterator,
        );
        this.readCache.delete(path);
        return;
      }
      next = await iterator.next();
    }

    // Fully buffered within the per-file cap. Do not touch posix:size here: the
    // wrapped (leaf) accessor records it on write, and adding it in this
    // decorator would store a duplicate, corrupting the resource's metadata.
    const queued = new RepresentationMetadata(metadata);
    if (this.writeQueue.enqueueWrite(path, chunks, queued, size)) {
      this.readCache.delete(path);
      this.writeQueue.kick();
    } else {
      // Queue budget exceeded: supersede any pending op and write through.
      await this.writeQueue.writeThrough(identifier, chunks, metadata);
      this.readCache.delete(path);
    }
  }

  public async writeContainer(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    // Containers carry only metadata and are cheap; keeping them write-through
    // avoids tracking pending container existence for listing coherence.
    await this.writeQueue.writeContainerThrough(identifier, metadata);
    this.readCache.delete(identifier.path);
  }

  public async writeMetadata(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const { path } = identifier;
    const op = this.writeQueue.peek(path);
    this.readCache.delete(path);
    if (op?.type === "write") {
      // Merge into the pending write so it flushes with the new metadata; the
      // resource is known to exist (it is queued for creation).
      this.writeQueue.mergeMetadata(path, new RepresentationMetadata(metadata));
      return;
    }
    // No pending write: write straight through. A missing resource then fails
    // immediately (rather than at a later flush), and getMetadata never reports
    // metadata for a resource that the source does not have.
    await this.writeQueue.writeMetadataThrough(identifier, metadata);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const { path } = identifier;
    const op = this.writeQueue.peek(path);
    this.readCache.delete(path);
    if (op?.type === "delete") {
      throw new NotFoundHttpError();
    }
    if (op?.type === "write") {
      // Lives only in the overlay: tombstone so reads 404 now; the flusher
      // removes any older source copy.
      this.writeQueue.enqueueDelete(path);
      this.writeQueue.kick();
      return;
    }
    // No pending op: delete straight through so a genuine 404 propagates.
    await this.writeQueue.deleteThrough(identifier);
  }

  public async finalize(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.writeQueue.flushAll();
  }

  /**
   * Reads from the source, caching the body (up to the per-file cap) as it
   * streams through. Re-checks the overlay before caching so a write that raced
   * in during the read never leaves a stale entry behind.
   */
  private async readFromSource(
    identifier: ResourceIdentifier,
  ): Promise<Guarded<Readable>> {
    const stream = await this.source.getData(identifier);
    const { path } = identifier;
    return tappedReadable(
      stream,
      this.readCache.maxFileSize,
      (chunks): void => {
        if (chunks && !this.writeQueue.peek(path)) {
          const size = chunks.reduce<number>(
            (total, chunk): number => total + chunk.length,
            0,
          );
          this.readCache.setData(path, chunks, size);
        }
      },
    );
  }
}
