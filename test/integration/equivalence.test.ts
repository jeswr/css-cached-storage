import type { Readable } from "node:stream";
import {
  guardedStreamFrom,
  InMemoryDataAccessor,
  NotFoundHttpError,
  RepresentationMetadata,
  type ResourceIdentifier,
  readableToString,
  SingleRootIdentifierStrategy,
} from "@solid/community-server";
import { CachingDataAccessor } from "../../src";

const BASE = "http://example.org/";

/** Deterministic LCG so a failing seed is reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function dataMeta(
  path: string,
  body: string,
): {
  id: ResourceIdentifier;
  stream: () => ReturnType<typeof guardedStreamFrom>;
  metadata: RepresentationMetadata;
} {
  const id = { path };
  return {
    id,
    stream: (): ReturnType<typeof guardedStreamFrom> =>
      guardedStreamFrom([Buffer.from(body)]),
    metadata: new RepresentationMetadata(id, "text/plain"),
  };
}

type Outcome =
  | { kind: "value"; value: string }
  | { kind: "notFound" }
  | { kind: "error" };

async function readOutcome(fn: () => Promise<Readable>): Promise<Outcome> {
  try {
    return { kind: "value", value: await readableToString(await fn()) };
  } catch (error: unknown) {
    return NotFoundHttpError.isInstance(error)
      ? { kind: "notFound" }
      : { kind: "error" };
  }
}

describe("CachingDataAccessor behavioural equivalence with the source", (): void => {
  it("matches a bare InMemoryDataAccessor across a randomised op sequence", async (): Promise<void> => {
    const strategy = new SingleRootIdentifierStrategy(BASE);
    const root: ResourceIdentifier = { path: BASE };

    const plain = new InMemoryDataAccessor(strategy);
    const backing = new InMemoryDataAccessor(strategy);
    const cache = new CachingDataAccessor({ source: backing });

    const rootMeta = new RepresentationMetadata(root, "internal/quads");
    await plain.writeContainer(root, new RepresentationMetadata(rootMeta));
    await backing.writeContainer(root, new RepresentationMetadata(rootMeta));

    const paths = ["a", "b", "c", "d"].map((p): string => `${BASE}${p}`);
    const random = rng(0xc0ffee);
    let writeCounter = 0;

    for (let step = 0; step < 300; step++) {
      const path = paths[Math.floor(random() * paths.length)];
      const roll = random();

      if (roll < 0.45) {
        // write
        const body = `body-${writeCounter++}`;
        const a = dataMeta(path, body);
        const b = dataMeta(path, body);
        await plain.writeDocument(a.id, a.stream(), a.metadata);
        await cache.writeDocument(b.id, b.stream(), b.metadata);
      } else if (roll < 0.6) {
        // delete (tolerating 404 on either side)
        const settle = async (acc: {
          deleteResource: (id: ResourceIdentifier) => Promise<void>;
        }): Promise<Outcome> => {
          try {
            await acc.deleteResource({ path });
            return { kind: "value", value: "" };
          } catch (error: unknown) {
            return NotFoundHttpError.isInstance(error)
              ? { kind: "notFound" }
              : { kind: "error" };
          }
        };
        const expected = await settle(plain);
        const actual = await settle(cache);
        expect(actual.kind).toBe(expected.kind);
      } else {
        // read data + metadata
        const expectedData = await readOutcome(
          (): Promise<Readable> => plain.getData({ path }),
        );
        const actualData = await readOutcome(
          (): Promise<Readable> => cache.getData({ path }),
        );
        expect(actualData).toEqual(expectedData);
      }

      // Occasionally flush so the queue path and the source path are both exercised.
      if (random() < 0.1) {
        await cache.finalize();
      }
    }

    await cache.finalize();

    // Final whole-state comparison: every path reads identically.
    for (const path of paths) {
      const expected = await readOutcome(
        (): Promise<Readable> => plain.getData({ path }),
      );
      const actual = await readOutcome(
        (): Promise<Readable> => cache.getData({ path }),
      );
      expect(actual).toEqual(expected);
    }

    // And the container listings match as sets.
    const listing = async (
      acc: InMemoryDataAccessor | CachingDataAccessor,
    ): Promise<string[]> => {
      const out: string[] = [];
      for await (const child of acc.getChildren(root)) {
        out.push(child.identifier.value);
      }
      return out.sort();
    };
    expect(await listing(cache)).toEqual(await listing(plain));
  });
});
