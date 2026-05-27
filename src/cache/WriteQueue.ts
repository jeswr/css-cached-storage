import {
  type DataAccessor,
  guardedStreamFrom,
  guardStream,
  NotFoundHttpError,
  RepresentationMetadata,
  type ResourceIdentifier,
} from "@solid/community-server";
import { PassThrough, writeChunk } from "../util/StreamUtil";

/** A buffered write: full data + metadata, not yet flushed to the source. */
interface WriteOp {
  type: "write";
  data: Buffer[];
  metadata: RepresentationMetadata;
  size: number;
}
/** A tombstone: the resource is to be removed from the source. */
interface DeleteOp {
  type: "delete";
}
export type PendingOp = WriteOp | DeleteOp;

/**
 * The authoritative in-memory overlay of pending mutations, plus the background
 * flusher that drains them to the source.
 *
 * Coherence rules that keep reads from ever going stale:
 *  - At most one pending op exists per path (later ops *coalesce* onto earlier
 *    ones via {@link Map} replacement), and it is the source of truth for that
 *    path until flushed.
 *  - Every operation that touches the source — the flusher and every foreground
 *    bypass/write-through/delete-through — runs inside {@link runExclusive}, so
 *    the source is never mutated by two operations at once and ordering is
 *    preserved (a foreground direct write always lands *after* an in-flight
 *    flush of the same path that it supersedes).
 */
export class WriteQueue {
  private readonly source: DataAccessor;
  private readonly maxQueueSize: number;
  private readonly pending = new Map<string, PendingOp>();
  private totalSize = 0;

  // Serialises all source mutations into a single chain.
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  private flushError: Error | undefined;
  private idleResolvers: (() => void)[] = [];

  public constructor(source: DataAccessor, maxQueueSize: number) {
    this.source = source;
    this.maxQueueSize = Math.max(0, maxQueueSize);
  }

  /** Current total bytes of buffered (un-flushed) document writes. */
  public get bufferedSize(): number {
    return this.totalSize;
  }

  /** Whether anything is awaiting a flush. */
  public get size(): number {
    return this.pending.size;
  }

  /** The pending op for a path, or `undefined` if none. */
  public peek(path: string): PendingOp | undefined {
    return this.pending.get(path);
  }

  /**
   * Buffers a document write. Returns `false` *without mutating state* when the
   * write would push the queue past `maxQueueSize` (the caller should then write
   * through synchronously); returns `true` once buffered.
   */
  public enqueueWrite(
    path: string,
    data: Buffer[],
    metadata: RepresentationMetadata,
    size: number,
  ): boolean {
    const previous = this.pending.get(path);
    const previousSize = previous?.type === "write" ? previous.size : 0;
    if (this.totalSize - previousSize + size > this.maxQueueSize) {
      return false;
    }
    this.totalSize += size - previousSize;
    this.pending.set(path, { type: "write", data, metadata, size });
    return true;
  }

  /**
   * Merges a metadata update onto an existing pending write so it flushes with
   * the new metadata. No-op when there is no pending write for the path (the
   * caller writes such updates straight through instead).
   */
  public mergeMetadata(path: string, metadata: RepresentationMetadata): void {
    const previous = this.pending.get(path);
    if (previous?.type === "write") {
      previous.metadata = metadata;
    }
  }

  /** Buffers a delete (tombstone), coalescing over any earlier pending op. */
  public enqueueDelete(path: string): void {
    this.releaseSize(path);
    this.pending.set(path, { type: "delete" });
  }

  /** Drops any pending op for a path. Used when a direct write supersedes it. */
  public remove(path: string): void {
    this.releaseSize(path);
    this.pending.delete(path);
  }

  private releaseSize(path: string): void {
    const previous = this.pending.get(path);
    if (previous?.type === "write") {
      this.totalSize -= previous.size;
    }
  }

  /**
   * Streams a document straight to the source, bypassing the buffer. Used for
   * bodies larger than the per-file queue cap so they are never held in memory
   * in full. Supersedes any pending op for the path and serialises against the
   * flusher.
   */
  public async bypassWrite(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
    prefix: Buffer[],
    rest: AsyncIterator<unknown>,
  ): Promise<void> {
    this.remove(identifier.path);
    await this.runExclusive(async (): Promise<void> => {
      const passthrough = new PassThrough();
      const done = this.source.writeDocument(
        identifier,
        guardStream(passthrough),
        new RepresentationMetadata(metadata),
      );
      try {
        for (const chunk of prefix) {
          await writeChunk(passthrough, chunk);
        }
        let next = await rest.next();
        while (next.done !== true) {
          await writeChunk(passthrough, Buffer.from(next.value as Buffer));
          next = await rest.next();
        }
        passthrough.end();
      } catch (error: unknown) {
        passthrough.destroy(error as Error);
      }
      await done;
    });
  }

  /** Writes a fully-buffered document straight to the source (queue-full path). */
  public async writeThrough(
    identifier: ResourceIdentifier,
    data: Buffer[],
    metadata: RepresentationMetadata,
  ): Promise<void> {
    this.remove(identifier.path);
    await this.runExclusive(
      (): Promise<void> =>
        this.source.writeDocument(
          identifier,
          guardedStreamFrom(data),
          new RepresentationMetadata(metadata),
        ),
    );
  }

  /** Deletes a resource straight from the source (no pending op existed). */
  public async deleteThrough(identifier: ResourceIdentifier): Promise<void> {
    await this.runExclusive(
      (): Promise<void> => this.source.deleteResource(identifier),
    );
  }

  /** Writes container metadata straight to the source, serialised against flushes. */
  public async writeContainerThrough(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    this.remove(identifier.path);
    await this.runExclusive(
      (): Promise<void> =>
        this.source.writeContainer(
          identifier,
          new RepresentationMetadata(metadata),
        ),
    );
  }

  /** Writes resource metadata straight to the source, serialised against flushes. */
  public async writeMetadataThrough(
    identifier: ResourceIdentifier,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    this.remove(identifier.path);
    await this.runExclusive(
      (): Promise<void> =>
        this.source.writeMetadata(
          identifier,
          new RepresentationMetadata(metadata),
        ),
    );
  }

  /** Starts the background flusher if there is work and it is not already running. */
  public kick(): void {
    if (!this.running && this.pending.size > 0) {
      this.running = true;
      queueMicrotask((): void => {
        void this.run();
      });
    }
  }

  /**
   * Flushes everything currently pending and resolves once the queue is idle.
   * Rethrows (once) any error the flusher hit, so callers such as `getChildren`
   * and `finalize` surface a source that cannot accept writes.
   */
  public async flushAll(): Promise<void> {
    this.kick();
    await this.waitIdle();
    if (this.flushError) {
      const error = this.flushError;
      this.flushError = undefined;
      throw error;
    }
  }

  private async run(): Promise<void> {
    try {
      this.flushError = undefined;
      while (this.pending.size > 0) {
        const entry = this.pending.entries().next().value;
        if (!entry) {
          break;
        }
        const [path, op] = entry;
        try {
          await this.runExclusive((): Promise<void> => this.apply(path, op));
        } catch (error: unknown) {
          // Keep the op pending for a later retry; surface via flushAll.
          this.flushError = error as Error;
          break;
        }
        // Only clear it if it was not coalesced into a newer op while in flight.
        if (this.pending.get(path) === op) {
          this.remove(path);
        }
      }
    } finally {
      this.running = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  private async apply(path: string, op: PendingOp): Promise<void> {
    const identifier: ResourceIdentifier = { path };
    if (op.type === "delete") {
      try {
        await this.source.deleteResource(identifier);
      } catch (error: unknown) {
        // A resource that only ever lived in the queue has nothing to delete.
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }
      return;
    }
    await this.source.writeDocument(
      identifier,
      guardedStreamFrom(op.data),
      new RepresentationMetadata(op.metadata),
    );
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then((): Promise<T> => fn());
    this.chain = result.then(
      (): undefined => undefined,
      (): undefined => undefined,
    );
    return result;
  }

  private async waitIdle(): Promise<void> {
    if (!this.running && this.pending.size === 0) {
      return;
    }
    await new Promise<void>((resolve): void => {
      this.idleResolvers.push(resolve);
    });
  }
}
