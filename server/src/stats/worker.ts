/**
 * Stats worker thread: runs StatsOps on its own read-only SQLite connection so heavy
 * dashboard queries never block the main event loop (WAL allows concurrent readers).
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { HttpError } from '../lib/errors.js';
import { StatsHandlers, type StatsOp } from './ops.js';

export interface WorkerRequest {
  id: number;
  op: StatsOp;
}

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; statusCode?: number } };

const port = parentPort;
if (!port) throw new Error('stats worker must run in a worker thread');
const { dbPath } = workerData as { dbPath: string };

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
// Defence in depth on top of the read-only open flag. Temporarily lifted only to build the
// export's TEMP visitor table (the read-only connection still cannot touch the main db).
db.pragma('query_only = 1');

const allowTempWrites = <T>(fn: () => T): T => {
  db.pragma('query_only = 0');
  try {
    return fn();
  } finally {
    db.pragma('query_only = 1');
  }
};

const handlers = new StatsHandlers(db, allowTempWrites);

port.on('message', (msg: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    res = { id: msg.id, ok: true, value: handlers.run(msg.op) };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    res = {
      id: msg.id,
      ok: false,
      error: e instanceof HttpError ? { message: e.message, statusCode: e.statusCode } : { message: e.message },
    };
  }
  port.postMessage(res);
});

port.postMessage({ ready: true });
