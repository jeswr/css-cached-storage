import { NotFoundHttpError, POSIX } from "@solid/community-server";
import {
  data,
  gate,
  type Harness,
  id,
  meta,
  ROOT,
  readStr,
  settlesWithin,
  setup,
} from "../util/helpers";

describe("CachingDataAccessor", (): void => {
  let h: Harness;

  beforeEach(async (): Promise<void> => {
    h = await setup({ flushIntervalMs: 0 });
  });

  describe("read caching", (): void => {
    it("serves a repeated read from cache without hitting the source again", async (): Promise<void> => {
      await h.cache.writeDocument(id("a"), data("hello"), meta(id("a")));
      await h.cache.finalize();
      const getData = jest.spyOn(h.source, "getData");

      expect(await readStr(await h.cache.getData(id("a")))).toBe("hello");
      expect(await readStr(await h.cache.getData(id("a")))).toBe("hello");

      expect(getData).toHaveBeenCalledTimes(1);
    });

    it("does not cache a body larger than maxReadFileSize", async (): Promise<void> => {
      h = await setup({ maxReadFileSize: 4 });
      await h.source.writeDocument(
        id("big"),
        data("123456789"),
        meta(id("big")),
      );
      const getData = jest.spyOn(h.source, "getData");

      expect(await readStr(await h.cache.getData(id("big")))).toBe("123456789");
      expect(await readStr(await h.cache.getData(id("big")))).toBe("123456789");

      expect(getData).toHaveBeenCalledTimes(2);
    });

    it("evicts least-recently-used bodies once the total cache size is exceeded", async (): Promise<void> => {
      // Cache holds ~6 bytes; each body is 5 bytes, so only one fits at a time.
      h = await setup({ maxReadCacheSize: 6 });
      await h.source.writeDocument(id("a"), data("aaaaa"), meta(id("a")));
      await h.source.writeDocument(id("b"), data("bbbbb"), meta(id("b")));
      const getData = jest.spyOn(h.source, "getData");

      await readStr(await h.cache.getData(id("a"))); // cache a (miss)
      await readStr(await h.cache.getData(id("b"))); // cache b, evict a (miss)
      await readStr(await h.cache.getData(id("a"))); // a was evicted (miss)

      expect(getData).toHaveBeenCalledTimes(3);
    });

    it("does not cache a negative result", async (): Promise<void> => {
      await expect(h.cache.getData(id("ghost"))).rejects.toThrow(
        NotFoundHttpError,
      );
      // Now it exists (written through the cache); the earlier miss must not mask it.
      await h.cache.writeDocument(id("ghost"), data("boo"), meta(id("ghost")));
      expect(await readStr(await h.cache.getData(id("ghost")))).toBe("boo");
    });
  });

  describe("write-back queue", (): void => {
    it("acknowledges a write before the slow source has stored it", async (): Promise<void> => {
      const g = gate();
      const original = h.source.writeDocument.bind(h.source);
      jest
        .spyOn(h.source, "writeDocument")
        .mockImplementation(async (...args): Promise<void> => {
          await g.wait;
          return original(...args);
        });

      // Resolves despite the source being gated → write-back.
      await h.cache.writeDocument(id("a"), data("queued"), meta(id("a")));
      // And the value is immediately visible from the overlay.
      expect(await readStr(await h.cache.getData(id("a")))).toBe("queued");

      g.open();
      await h.cache.finalize();
      expect(await readStr(await h.source.getData(id("a")))).toBe("queued");
    });

    it("records the binary size on queued writes", async (): Promise<void> => {
      await h.cache.writeDocument(id("a"), data("12345"), meta(id("a")));
      const md = await h.cache.getMetadata(id("a"));
      expect(md.get(POSIX.terms.size)?.value).toBe("5");
    });

    it("flushes pending writes on finalize", async (): Promise<void> => {
      await h.cache.writeDocument(id("a"), data("one"), meta(id("a")));
      await h.cache.writeDocument(id("b"), data("two"), meta(id("b")));
      await h.cache.finalize();

      expect(await readStr(await h.source.getData(id("a")))).toBe("one");
      expect(await readStr(await h.source.getData(id("b")))).toBe("two");
    });

    it("bypasses the queue for a body larger than maxWriteQueueFileSize", async (): Promise<void> => {
      h = await setup({ maxWriteQueueFileSize: 4 });
      const writeDocument = jest.spyOn(h.source, "writeDocument");

      await h.cache.writeDocument(
        id("big"),
        data("123456789"),
        meta(id("big")),
      );

      // Bypass writes straight through, so the source already has it (no finalize).
      expect(writeDocument).toHaveBeenCalledTimes(1);
      expect(await readStr(await h.source.getData(id("big")))).toBe(
        "123456789",
      );
    });

    it("falls back to write-through when the queue budget is exceeded", async (): Promise<void> => {
      h = await setup({ maxWriteQueueSize: 5 });
      const g = gate();
      const original = h.source.writeDocument.bind(h.source);
      jest
        .spyOn(h.source, "writeDocument")
        .mockImplementation(async (...args): Promise<void> => {
          await g.wait;
          return original(...args);
        });

      // Fills the 5-byte queue; returns fast (write-back).
      const first = h.cache.writeDocument(
        id("a"),
        data("aaaaa"),
        meta(id("a")),
      );
      expect(await settlesWithin(first)).toBe(true);

      // Exceeds the budget → write-through, which blocks on the gated source.
      const second = h.cache.writeDocument(id("b"), data("b"), meta(id("b")));
      expect(await settlesWithin(second)).toBe(false);

      g.open();
      await second;
      await h.cache.finalize();
      expect(await readStr(await h.source.getData(id("b")))).toBe("b");
    });
  });

  describe("no stale reads", (): void => {
    it("reads a queued (un-flushed) write from the overlay, not the source", async (): Promise<void> => {
      const g = gate();
      const original = h.source.writeDocument.bind(h.source);
      jest
        .spyOn(h.source, "writeDocument")
        .mockImplementation(async (...args): Promise<void> => {
          await g.wait;
          return original(...args);
        });
      const getData = jest.spyOn(h.source, "getData");

      await h.cache.writeDocument(id("a"), data("fresh"), meta(id("a")));
      expect(await readStr(await h.cache.getData(id("a")))).toBe("fresh");
      expect(getData).not.toHaveBeenCalled();

      g.open();
      await h.cache.finalize();
    });

    it("overwrites a previously-cached read so the new value is never stale", async (): Promise<void> => {
      await h.cache.writeDocument(id("a"), data("v1"), meta(id("a")));
      await h.cache.finalize();
      expect(await readStr(await h.cache.getData(id("a")))).toBe("v1"); // populates cache

      await h.cache.writeDocument(id("a"), data("v2"), meta(id("a")));
      expect(await readStr(await h.cache.getData(id("a")))).toBe("v2");
      await h.cache.finalize();
      expect(await readStr(await h.cache.getData(id("a")))).toBe("v2");
    });

    it("returns 404 for a tombstoned (queued-delete) resource", async (): Promise<void> => {
      const g = gate();
      const original = h.source.writeDocument.bind(h.source);
      jest
        .spyOn(h.source, "writeDocument")
        .mockImplementation(async (...args): Promise<void> => {
          await g.wait;
          return original(...args);
        });

      await h.cache.writeDocument(id("a"), data("doomed"), meta(id("a")));
      await h.cache.deleteResource(id("a")); // tombstones the queued write

      await expect(h.cache.getData(id("a"))).rejects.toThrow(NotFoundHttpError);
      await expect(h.cache.getMetadata(id("a"))).rejects.toThrow(
        NotFoundHttpError,
      );

      g.open();
      await h.cache.finalize();
      await expect(h.source.getData(id("a"))).rejects.toThrow(
        NotFoundHttpError,
      );
    });

    it("reflects a queued metadata update on the next getMetadata", async (): Promise<void> => {
      await h.cache.writeDocument(id("a"), data("body"), meta(id("a")));
      await h.cache.finalize();

      const updated = meta(id("a"), "application/json");
      await h.cache.writeMetadata(id("a"), updated);

      const md = await h.cache.getMetadata(id("a"));
      expect(md.contentType).toBe("application/json");
      // Data is unchanged and still reachable.
      expect(await readStr(await h.cache.getData(id("a")))).toBe("body");
    });

    it("getChildren reflects queued creates and deletes", async (): Promise<void> => {
      await h.cache.writeDocument(id("keep"), data("k"), meta(id("keep")));
      await h.cache.writeDocument(id("gone"), data("g"), meta(id("gone")));
      await h.cache.finalize();

      // Queue a new child and a delete, both un-flushed.
      await h.cache.writeDocument(id("added"), data("a"), meta(id("added")));
      await h.cache.deleteResource(id("gone"));

      const children: string[] = [];
      for await (const child of h.cache.getChildren(ROOT)) {
        children.push(child.identifier.value);
      }
      expect(children).toContain(id("keep").path);
      expect(children).toContain(id("added").path);
      expect(children).not.toContain(id("gone").path);
    });
  });

  describe("error handling", (): void => {
    it("propagates a NotFoundHttpError for a missing resource", async (): Promise<void> => {
      await expect(h.cache.getData(id("nope"))).rejects.toThrow(
        NotFoundHttpError,
      );
      await expect(h.cache.getMetadata(id("nope"))).rejects.toThrow(
        NotFoundHttpError,
      );
    });

    it("propagates a source read error", async (): Promise<void> => {
      jest
        .spyOn(h.source, "getData")
        .mockRejectedValueOnce(new Error("disk on fire"));
      await expect(h.cache.getData(id("a"))).rejects.toThrow("disk on fire");
    });

    it("surfaces a flush failure via finalize", async (): Promise<void> => {
      jest
        .spyOn(h.source, "writeDocument")
        .mockRejectedValue(new Error("flush failed"));
      await h.cache.writeDocument(id("a"), data("x"), meta(id("a")));
      await expect(h.cache.finalize()).rejects.toThrow("flush failed");
    });
  });
});
