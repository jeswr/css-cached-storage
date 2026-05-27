import type { Readable } from "node:stream";
import {
  type Guarded,
  guardedStreamFrom,
  InMemoryDataAccessor,
  RepresentationMetadata,
  type ResourceIdentifier,
  readableToString,
  SingleRootIdentifierStrategy,
} from "@solid/community-server";
import { CachingDataAccessor, type CachingDataAccessorArgs } from "../../src";

export const BASE = "http://example.org/";

/** Build a {@link ResourceIdentifier} from a path relative to {@link BASE}. */
export function id(relative: string): ResourceIdentifier {
  return { path: `${BASE}${relative}` };
}

/** The root container identifier. */
export const ROOT: ResourceIdentifier = { path: BASE };

/** A guarded readable carrying `body` as a single binary chunk. */
export function data(body: string): Guarded<Readable> {
  return guardedStreamFrom([Buffer.from(body)]);
}

/** Metadata for `identifier` with the given content type (default text/plain). */
export function meta(
  identifier: ResourceIdentifier,
  contentType = "text/plain",
): RepresentationMetadata {
  return new RepresentationMetadata(identifier, contentType);
}

/** Drains a readable to a string. */
export async function readStr(stream: Readable): Promise<string> {
  return readableToString(stream);
}

/** A manually-controlled gate, for pausing a mocked source operation. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve): void => {
    open = resolve;
  });
  return { wait, open };
}

/** Resolves `true` if `promise` settles within `ms`, else `false` (still pending). */
export async function settlesWithin(
  promise: Promise<unknown>,
  ms = 25,
): Promise<boolean> {
  const pending = Symbol("pending");
  const timer = new Promise<typeof pending>((resolve): void => {
    setTimeout((): void => resolve(pending), ms).unref();
  });
  const result = await Promise.race([
    promise.then((): "settled" => "settled").catch((): "settled" => "settled"),
    timer,
  ]);
  return result !== pending;
}

export interface Harness {
  source: InMemoryDataAccessor;
  cache: CachingDataAccessor;
}

/**
 * Builds a {@link CachingDataAccessor} over a real {@link InMemoryDataAccessor},
 * with the root container created so documents can be written. Override any
 * cache option via `args`.
 */
export async function setup(
  args: Partial<Omit<CachingDataAccessorArgs, "source">> = {},
): Promise<Harness> {
  const strategy = new SingleRootIdentifierStrategy(BASE);
  const source = new InMemoryDataAccessor(strategy);
  await source.writeContainer(ROOT, meta(ROOT, "internal/quads"));
  const cache = new CachingDataAccessor({ source, ...args });
  return { source, cache };
}
