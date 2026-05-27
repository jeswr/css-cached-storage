import { once } from "node:events";
import type { Readable } from "node:stream";
import { PassThrough, Transform } from "node:stream";
import { type Guarded, guardStream } from "@solid/community-server";

/**
 * Pipes `source` straight through, forwarding every chunk unchanged to the
 * consumer, while *tapping* a copy of the bytes into an in-memory buffer so the
 * body can be cached — but only up to `maxSize` bytes. If the stream grows past
 * `maxSize` the partial buffer is dropped (and never rebuilt), so an oversized
 * resource is streamed to the consumer without ever being held in full.
 *
 * `onComplete` fires exactly once, and only when the stream *ends cleanly*:
 *  - with the collected chunks when the body stayed within `maxSize`;
 *  - with `undefined` when it exceeded `maxSize`.
 * A consumer that abandons the stream early triggers neither branch, so a
 * partially-read body is never cached.
 */
export function tappedReadable(
  source: Readable,
  maxSize: number,
  onComplete: (chunks: Buffer[] | undefined) => void,
): Guarded<Readable> {
  let chunks: Buffer[] | undefined = [];
  let size = 0;

  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      if (chunks) {
        size += chunk.length;
        if (size > maxSize) {
          // Too large to cache: drop what we have and stop buffering.
          chunks = undefined;
        } else {
          chunks.push(Buffer.from(chunk));
        }
      }
      callback(null, chunk);
    },
    flush(callback): void {
      onComplete(chunks);
      callback();
    },
  });

  // Forward upstream errors so the consumer (and guard) sees them.
  source.on("error", (error: Error): void => {
    tap.destroy(error);
  });
  source.pipe(tap);
  return guardStream(tap);
}

/**
 * Writes a chunk to `stream`, awaiting `drain` when the internal buffer is full
 * so a fast producer cannot grow the buffer without bound. Rejects if the
 * stream errors while we wait, rather than hanging forever.
 */
export async function writeChunk(
  stream: PassThrough,
  chunk: Buffer,
): Promise<void> {
  if (!stream.write(chunk)) {
    const controller = new AbortController();
    try {
      await Promise.race([
        once(stream, "drain", { signal: controller.signal }),
        once(stream, "error", { signal: controller.signal }).then(
          ([error]): never => {
            throw error;
          },
        ),
      ]);
    } finally {
      controller.abort();
    }
  }
}

export { PassThrough };
