import { RepresentationMetadata } from "@solid/community-server";
import { ReadCache } from "../../../src/cache/ReadCache";

function bytes(n: number): Buffer[] {
  return [Buffer.alloc(n, 1)];
}

describe("ReadCache", (): void => {
  it("stores and returns data for a path", (): void => {
    const cache = new ReadCache(1000, 100);
    cache.setData("a", bytes(5), 5);
    expect(cache.get("a")?.data).toEqual(bytes(5));
    expect(cache.get("a")?.dataSize).toBe(5);
  });

  it("refuses (and evicts) a body larger than maxFileSize", (): void => {
    const cache = new ReadCache(1000, 4);
    cache.setData("a", bytes(2), 2);
    cache.setData("a", bytes(9), 9); // over the per-file cap
    expect(cache.get("a")).toBeUndefined();
  });

  it("keeps data and metadata independently mergeable", (): void => {
    const cache = new ReadCache(1000, 100);
    const md = new RepresentationMetadata({ path: "a" }, "text/plain");
    cache.setMetadata("a", md);
    cache.setData("a", bytes(3), 3);
    expect(cache.get("a")?.data).toEqual(bytes(3));
    expect(cache.get("a")?.metadata).toBe(md);

    // Setting metadata again preserves the data.
    const md2 = new RepresentationMetadata({ path: "a" }, "application/json");
    cache.setMetadata("a", md2);
    expect(cache.get("a")?.data).toEqual(bytes(3));
    expect(cache.get("a")?.metadata).toBe(md2);
  });

  it("evicts the least-recently-used entry past maxCacheSize", (): void => {
    const cache = new ReadCache(6, 100); // ~one 5-byte body at a time
    cache.setData("a", bytes(5), 5);
    cache.setData("b", bytes(5), 5);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.dataSize).toBe(5);
  });

  it("clears and deletes entries", (): void => {
    const cache = new ReadCache(1000, 100);
    cache.setData("a", bytes(1), 1);
    cache.setData("b", bytes(1), 1);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});
