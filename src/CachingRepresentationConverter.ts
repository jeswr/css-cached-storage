import {
  BasicRepresentation,
  cleanPreferences,
  DC,
  getConversionTarget,
  getTypeWeight,
  guardedStreamFrom,
  HH,
  isInternalContentType,
  POSIX,
  type Representation,
  RepresentationConverter,
  type RepresentationConverterArgs,
  RepresentationMetadata,
  type ValuePreferences,
} from "@solid/community-server";
import { LRUCache } from "lru-cache";
import { dropStream, tappedReadable } from "./util/StreamUtil";

const MIB = 1024 * 1024;

/**
 * Configuration for a {@link CachingRepresentationConverter}. All sizes are in bytes.
 */
export interface CachingRepresentationConverterArgs {
  /** The converter whose (already serialized) output is cached. */
  source: RepresentationConverter;
  /** Total bytes of converted output the cache may retain (LRU eviction). Default 256 MiB. */
  maxCacheSize?: number;
  /** Largest single converted output admitted to the cache; bigger outputs are served uncached. Default 1 MiB. */
  maxEntrySize?: number;
}

/** One cached serialization of a resource, keyed by its output content-type. */
interface CachedOutput {
  data: Buffer[];
  size: number;
  metadata: RepresentationMetadata;
}

/**
 * All cached serializations of a single resource *at one version*. If the
 * resource is rewritten the version token changes and the whole entry is
 * replaced, so a stale serialization can never be served.
 */
interface CacheEntry {
  version: string;
  outputs: Map<string, CachedOutput>;
}

/** Total bytes held by an entry across all its cached output types (min 1 for LRU). */
function entrySize(entry: CacheEntry): number {
  let total = 0;
  for (const output of entry.outputs.values()) {
    total += output.size;
  }
  return Math.max(1, total);
}

/**
 * Derives a token that changes whenever the resource is (re)written, so the
 * cache can be keyed on resource *state* rather than path alone.
 *
 * Prefers an explicit ETag if the metadata carries one; otherwise combines the
 * last-modified date with the byte size. Returns `undefined` when neither is
 * available, in which case the caller must not cache.
 *
 * NOTE: `dc:modified` is (at most) second-granular in CSS, so two writes within
 * the same second that also leave `posix:size` unchanged would not bump the
 * token — a sub-second double-write edge where a stale serialization could be
 * served. ETag-carrying metadata avoids this; the file backend's mtime is
 * second-granular too, which is the practical floor here.
 */
function computeVersion(metadata: RepresentationMetadata): string | undefined {
  const etag = metadata.get(HH.terms.etag);
  if (etag) {
    return `etag:${etag.value}`;
  }
  const modified = metadata.get(DC.terms.modified);
  if (modified) {
    const size = metadata.get(POSIX.terms.size);
    return `mtime:${modified.value}|size:${size?.value ?? "-"}`;
  }
  return undefined;
}

/**
 * A {@link RepresentationConverter} that caches the *serialized* output of a
 * wrapped converter, per content-type, keyed by resource version.
 *
 * The existing raw byte cache stores a resource in the single format it is
 * persisted in. When a client requests a *different* content-type (e.g. Turtle
 * on disk, `Accept: application/ld+json`), CSS re-parses **and** re-serializes on
 * every request. This decorator sits at the out-conversion step and remembers
 * the bytes it produced, so a repeat cross-type read skips both the parse and
 * the serialize.
 *
 * **Version keying.** Each entry records a version token
 * ({@link computeVersion}) taken from the resource's own metadata. A write bumps
 * `dc:modified`/the ETag, so the next read computes a different token and the
 * stale entry is dropped rather than served — the cache self-invalidates.
 *
 * **Only genuine conversions are cached.** When the requested type equals the
 * stored type the wrapped converter returns the representation untouched (a
 * passthrough); that case is returned as-is and never cached, since the raw byte
 * cache already covers it. Object streams (`internal/quads`, `binary === false`)
 * are likewise never cached — only client-facing binary serializations are.
 *
 * **Multi-worker note.** Because this is version-keyed (not path-keyed like the
 * raw read cache), it is more cluster-coherent: a worker will not serve a
 * serialization for a version it has not observed. Full cluster coherence is
 * still out of scope — it relies on the metadata read that produced the version
 * being current, which a shared/coherent store would have to guarantee.
 */
export class CachingRepresentationConverter extends RepresentationConverter {
  private readonly source: RepresentationConverter;
  private readonly maxEntrySize: number;
  private readonly cache: LRUCache<string, CacheEntry>;

  public constructor(args: CachingRepresentationConverterArgs) {
    super();
    this.source = args.source;
    this.maxEntrySize = args.maxEntrySize ?? MIB;
    this.cache = new LRUCache<string, CacheEntry>({
      maxSize: Math.max(1, args.maxCacheSize ?? 256 * MIB),
      sizeCalculation: (entry): number => entrySize(entry),
    });
  }

  public override async canHandle(
    input: RepresentationConverterArgs,
  ): Promise<void> {
    // Delegate acceptance to the wrapped converter: this decorator accepts
    // exactly what its source can convert (which also enforces the
    // "must have a Content-Type" precondition of the chained converter).
    return this.source.canHandle(input);
  }

  public override async handle(
    input: RepresentationConverterArgs,
  ): Promise<Representation> {
    const { identifier, representation, preferences } = input;
    const { path } = identifier;
    const inType = representation.metadata.contentType;
    const version = computeVersion(representation.metadata);

    // No stable version token → cannot safely key the cache: stream straight
    // through without caching. (The wrapped converter consumes the input.)
    if (version === undefined) {
      return this.source.handle(input);
    }

    const hit = this.serveFromCache(path, version, representation, preferences);
    if (hit) {
      return hit;
    }

    // MISS: run the real conversion.
    const converted = await this.source.handle(input);
    const outType = converted.metadata.contentType;

    // Passthrough (requested type === stored type) or an object/internal stream:
    // return untouched and do not cache. A same-type passthrough is already
    // covered by the raw byte cache, and object streams cannot be buffered as
    // bytes for re-serving.
    if (
      outType === undefined ||
      outType === inType ||
      !converted.binary ||
      isInternalContentType(outType)
    ) {
      return converted;
    }

    // Genuine conversion: stream the serialized output to the caller while
    // tapping a copy (bounded by `maxEntrySize`) to cache, so a repeat cross-type
    // read can skip both the parse and the serialize. An oversized output streams
    // straight through and is never held in memory in full — matching the raw
    // cache's behaviour and avoiding an OOM on a large uncacheable conversion.
    //
    // Snapshot the metadata now, before the caller can mutate the returned copy,
    // so the version the tap caches on stream-end matches the bytes it produced.
    const cachedMetadata = new RepresentationMetadata(converted.metadata);
    const tapped = tappedReadable(
      converted.data,
      this.maxEntrySize,
      (chunks): void => {
        if (chunks) {
          const size = chunks.reduce(
            (total, chunk): number => total + chunk.length,
            0,
          );
          this.store(path, version, outType, chunks, size, cachedMetadata);
        }
      },
    );
    return new BasicRepresentation(tapped, converted.metadata, true);
  }

  /**
   * Returns a cached serialization that satisfies `preferences`, or `undefined`
   * on a miss. On a hit the unused input `representation.data` is released,
   * since the source is bypassed and its already-open stream must not dangle.
   *
   * To stay transparent to content negotiation, a cached type is only served
   * when it is *strictly preferred* over serving the stored bytes as-is. Under a
   * wildcard Accept (or no Accept) the stored type ties every cached type, so we
   * defer to the source — which does the cheap passthrough — rather than
   * unilaterally handing back a previously-converted type. Only when the client
   * genuinely prefers a converted type (stored type weight lower) do we serve
   * from cache.
   */
  private serveFromCache(
    path: string,
    version: string,
    representation: Representation,
    preferences: RepresentationConverterArgs["preferences"],
  ): Representation | undefined {
    const entry = this.cache.get(path);
    if (!entry || entry.version !== version) {
      return undefined;
    }
    // Negotiate the requested Accept against the types we already hold, reusing
    // the server's own content-negotiation so the choice matches a real convert.
    const targets: ValuePreferences = {};
    for (const type of entry.outputs.keys()) {
      targets[type] = 1;
    }
    const target = getConversionTarget(targets, preferences.type);
    if (target === undefined) {
      return undefined;
    }
    const cleaned = cleanPreferences(preferences.type);
    const inType = representation.metadata.contentType;
    const storedWeight = inType ? getTypeWeight(inType, cleaned) : 0;
    if (getTypeWeight(target, cleaned) <= storedWeight) {
      // The stored representation is (at least) as preferred: let the source
      // handle it so behaviour matches an uncached server.
      return undefined;
    }
    const output = entry.outputs.get(target);
    if (!output) {
      return undefined;
    }
    dropStream(representation.data);
    return new BasicRepresentation(
      guardedStreamFrom(output.data),
      new RepresentationMetadata(output.metadata),
      true,
    );
  }

  /**
   * Stores a serialized output under `path`/`outType`. Replaces the whole entry
   * when the version changed (dropping every stale serialization), otherwise
   * adds/overwrites just this output type. A private metadata copy is cached so
   * a caller can never mutate the shared entry.
   */
  private store(
    path: string,
    version: string,
    outType: string,
    data: Buffer[],
    size: number,
    metadata: RepresentationMetadata,
  ): void {
    let entry = this.cache.get(path);
    if (!entry || entry.version !== version) {
      entry = { version, outputs: new Map<string, CachedOutput>() };
    }
    entry.outputs.set(outType, {
      data,
      size,
      metadata: new RepresentationMetadata(metadata),
    });
    this.cache.set(path, entry, { size: entrySize(entry) });
  }
}
