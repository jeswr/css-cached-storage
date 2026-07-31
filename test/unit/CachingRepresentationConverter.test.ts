import {
  BasicRepresentation,
  DC,
  HH,
  POSIX,
  type Representation,
  RepresentationConverter,
  type RepresentationConverterArgs,
  RepresentationMetadata,
  readableToString,
  type ValuePreferences,
} from "@solid/community-server";
import { CachingRepresentationConverter } from "../../src";
import { id, readStr } from "../util/helpers";

/**
 * A stand-in for the real out-converter. It drains the input (as a real
 * parse-and-serialize converter would) and returns a fresh representation whose
 * content-type is `outType` and whose body is `body`. `handle` is spied on so
 * tests can assert how often a genuine conversion actually ran.
 */
class StubConverter extends RepresentationConverter {
  public lastReturned?: Representation;

  public constructor(
    public outType: string,
    public body: string,
  ) {
    super();
  }

  public override async handle({
    representation,
  }: RepresentationConverterArgs): Promise<Representation> {
    // A real converter reads its input to parse it.
    await readableToString(representation.data);
    const metadata = new RepresentationMetadata(
      representation.metadata,
      this.outType,
    );
    const result = new BasicRepresentation(this.body, metadata);
    this.lastReturned = result;
    return result;
  }
}

const JSONLD = "application/ld+json";
const TURTLE = "text/turtle";
const HTML = "text/html";

interface InputOptions {
  inType?: string;
  accept: ValuePreferences;
  modified?: string;
  size?: number;
  etag?: string;
}

/** Builds converter input for `path`, with version-bearing stored metadata. */
function input(
  path: string,
  { inType = "text/turtle", accept, modified, size, etag }: InputOptions,
): RepresentationConverterArgs {
  const identifier = id(path);
  const metadata = new RepresentationMetadata(identifier, inType);
  if (modified !== undefined) {
    metadata.set(DC.terms.modified, modified);
  }
  if (size !== undefined) {
    metadata.set(POSIX.terms.size, `${size}`);
  }
  if (etag !== undefined) {
    metadata.set(HH.terms.etag, etag);
  }
  const representation = new BasicRepresentation("SOURCE-BYTES", metadata);
  return { identifier, representation, preferences: { type: accept } };
}

describe("CachingRepresentationConverter", (): void => {
  it("caches a cross-type conversion and skips the source on a repeat request", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    const first = input("a", { accept: { [JSONLD]: 1 }, modified: "t1" });
    const r1 = await converter.handle(first);
    expect(r1.metadata.contentType).toBe(JSONLD);
    expect(await readStr(r1.data)).toBe("JSONLD-BYTES");

    const second = input("a", { accept: { [JSONLD]: 1 }, modified: "t1" });
    const r2 = await converter.handle(second);
    expect(await readStr(r2.data)).toBe("JSONLD-BYTES");
    expect(r2.metadata.contentType).toBe(JSONLD);

    // The source ran once; the second read came from cache.
    expect(handle).toHaveBeenCalledTimes(1);
    // The unused input stream on the cache hit was released, not left dangling.
    expect(second.representation.data.destroyed).toBe(true);
  });

  it("calls the source again for an Accept no cached type satisfies", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    // text/html is not among the cached types → negotiation misses → source runs.
    await converter.handle(
      input("a", { accept: { [HTML]: 1 }, modified: "t1" }),
    );

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("stays transparent under Accept: */* (defers to the source, not the cache)", async (): Promise<void> => {
    // A cached converted type must not override the server's default negotiation:
    // under */* the stored type ties, so the source (cheap passthrough) wins.
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    // Explicit request caches the ld+json serialization.
    await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    // A wildcard request must NOT be served the cached ld+json; the source runs.
    await converter.handle(
      input("a", { accept: { "*/*": 1 }, modified: "t1" }),
    );

    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("invalidates the entry when the resource version changes", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    // v1 → cached (the tapped output is cached once its stream is fully read).
    await readableToString(
      (
        await converter.handle(
          input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
        )
      ).data,
    );
    // v2 (new dc:modified) → stale entry dropped, source runs again.
    await readableToString(
      (
        await converter.handle(
          input("a", { accept: { [JSONLD]: 1 }, modified: "t2" }),
        )
      ).data,
    );
    expect(handle).toHaveBeenCalledTimes(2);

    // The new version is now cached: a third identical read is a hit.
    await readableToString(
      (
        await converter.handle(
          input("a", { accept: { [JSONLD]: 1 }, modified: "t2" }),
        )
      ).data,
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("also version-keys on a changed posix:size (same modified time)", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1", size: 10 }),
    );
    await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1", size: 20 }),
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("prefers an ETag as the version token when present", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    // Same ETag across reads → hit despite no modified/size.
    await readableToString(
      (
        await converter.handle(
          input("a", { accept: { [JSONLD]: 1 }, etag: '"v1"' }),
        )
      ).data,
    );
    await readableToString(
      (
        await converter.handle(
          input("a", { accept: { [JSONLD]: 1 }, etag: '"v1"' }),
        )
      ).data,
    );
    expect(handle).toHaveBeenCalledTimes(1);

    // Changed ETag → invalidated.
    await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, etag: '"v2"' }),
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("does not cache when no version token can be derived", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    // No modified / size / etag → uncacheable → source runs every time.
    await converter.handle(input("a", { accept: { [JSONLD]: 1 } }));
    await converter.handle(input("a", { accept: { [JSONLD]: 1 } }));
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("returns a same-type passthrough untouched and never caches it", async (): Promise<void> => {
    // outType === inType → the source performed no real conversion.
    const source = new StubConverter(TURTLE, "TURTLE-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    const r1 = await converter.handle(
      input("a", { inType: TURTLE, accept: { [TURTLE]: 1 }, modified: "t1" }),
    );
    // The exact object the source produced is handed back unmodified.
    expect(r1).toBe(source.lastReturned);
    expect(await readStr(r1.data)).toBe("TURTLE-BYTES");

    // Not cached: a second identical read hits the source again.
    await converter.handle(
      input("a", { inType: TURTLE, accept: { [TURTLE]: 1 }, modified: "t1" }),
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("serves but does not cache an output larger than maxEntrySize", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "123456789"); // 9 bytes
    const converter = new CachingRepresentationConverter({
      source,
      maxEntrySize: 4,
    });
    const handle = jest.spyOn(source, "handle");

    const r1 = await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    expect(await readStr(r1.data)).toBe("123456789");

    // Too big to admit → the repeat read re-runs the source.
    const r2 = await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    expect(await readStr(r2.data)).toBe("123456789");
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("hands out a metadata copy so a caller cannot corrupt the cache", async (): Promise<void> => {
    const source = new StubConverter(JSONLD, "JSONLD-BYTES");
    const converter = new CachingRepresentationConverter({ source });
    const handle = jest.spyOn(source, "handle");

    const r1 = await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    // Mutate the returned metadata: a caller must not be sharing the cached copy.
    r1.metadata.contentType = HTML;
    r1.metadata.set(DC.terms.title, "mutated");
    // Draining the response is what populates the cache; the cached metadata is
    // the snapshot taken at handle time, before the above mutation.
    await readableToString(r1.data);

    const r2 = await converter.handle(
      input("a", { accept: { [JSONLD]: 1 }, modified: "t1" }),
    );
    // Still a cache hit, and the cached metadata is pristine.
    expect(handle).toHaveBeenCalledTimes(1);
    expect(r2.metadata.contentType).toBe(JSONLD);
    expect(r2.metadata.get(DC.terms.title)).toBeUndefined();
  });
});
