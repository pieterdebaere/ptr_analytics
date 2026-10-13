import type { DB } from '../db/index.js';

/** Initial rows per DELETE; each chunk is its own short write transaction. */
export const CLEANUP_CHUNK = 1000;
const MIN_CHUNK = 100;
const MAX_CHUNK = 5000;
/** Chunk sizes adapt so one DELETE blocks the event loop for about this long. */
const TARGET_CHUNK_MS = 25;

/** Pause between chunks: as long as the chunk took (max 100 ms), i.e. at most ~50% of the main thread. */
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, Math.round(ms)))));

/**
 * Run `run(limit)` (one DELETE of at most `limit` rows, returning the number deleted) until
 * it deletes fewer rows than asked, pausing between chunks. Random-keyed indexes (sessions)
 * make some deletes far costlier per row than others, so the chunk size adapts to the
 * measured time instead of using a fixed row count. Stops when the database is closed.
 */
export async function drainChunks(db: DB, run: (limit: number) => number, add: (n: number) => void = () => {}): Promise<void> {
  let size = CLEANUP_CHUNK;
  for (;;) {
    if (!db.open) return;
    const started = performance.now();
    const n = run(size);
    const ms = performance.now() - started;
    add(n);
    if (n < size) return;
    if (ms > TARGET_CHUNK_MS * 2) size = Math.max(MIN_CHUNK, Math.floor(size / 2));
    else if (ms < TARGET_CHUNK_MS / 2) size = Math.min(MAX_CHUNK, size * 2);
    await pause(ms);
  }
}
