import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DB } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { StatsHandlers, type OpOf, type StatsOpKind, type StatsResults } from './ops.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';

/** Identifies the connection an op ran on (export cursors live on one connection). */
export interface Pin {
  slot: number;
  gen: number;
}

export interface Ran<T> {
  value: T;
  pin: Pin;
}

export interface StatsExecutor {
  readonly mode: 'inline' | 'workers';
  /** `owner` (the requesting user) is used for fair queueing between users. */
  run<K extends StatsOpKind>(op: OpOf<K>, pin?: Pin, owner?: string): Promise<Ran<StatsResults[K]>>;
  close(): Promise<void>;
}

export const queryTimedOut = (): HttpError => new HttpError(503, 'query timed out');
const unavailable = (): HttpError => new HttpError(503, 'service unavailable');

/**
 * In-process fallback (in-memory databases, i.e. tests, or no worker entry available).
 * Yields to the event loop before every op so streamed exports never starve it.
 */
export class InlineExecutor implements StatsExecutor {
  readonly mode = 'inline' as const;
  private readonly handlers: StatsHandlers;
  private closed = false;

  constructor(db: DB) {
    this.handlers = new StatsHandlers(db);
  }

  async run<K extends StatsOpKind>(op: OpOf<K>): Promise<Ran<StatsResults[K]>> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.closed) throw unavailable();
    return { value: this.handlers.run(op), pin: { slot: 0, gen: 0 } };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Task {
  id: number;
  op: OpOf<StatsOpKind>;
  pin: Pin | undefined;
  owner: string;
  resolve: (r: Ran<unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  slot: Slot | null;
}

interface Slot {
  index: number;
  gen: number;
  worker: Worker | null;
  task: Task | null;
  /** Terminated (timeout / crash) but not exited yet: occupies its slot until it does. */
  dying: boolean;
  failures: number;
}

/** How to start a worker: a module URL (compiled JS), or bootstrap code to `eval`. */
const MAX_TRACKED_OWNERS = 10_000;

export interface WorkerEntry {
  url: URL;
  /** Bootstrap that loads the tsx loader and then imports `url` (TS sources). */
  code?: string;
}

/**
 * The worker entry next to this module: `worker.js` when running the compiled build (dist),
 * else `worker.ts` through the tsx loader (tsx dev mode, vitest). Null if neither works.
 */
export function resolveWorkerEntry(): WorkerEntry | null {
  const js = new URL('./worker.js', import.meta.url);
  if (fs.existsSync(fileURLToPath(js))) return { url: js };
  const ts = new URL('./worker.ts', import.meta.url);
  if (!fs.existsSync(fileURLToPath(ts))) return null;
  let api: string;
  try {
    // `--import tsx` in a worker's execArgv is not honoured: register tsx inside the worker.
    const require = createRequire(import.meta.url);
    const pkgFile = require.resolve('tsx/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as { exports?: Record<string, { import?: { default?: string } }> };
    const rel = pkg.exports?.['./esm/api']?.import?.default;
    if (!rel) return null;
    api = pathToFileURL(path.join(path.dirname(pkgFile), rel)).href;
  } catch {
    return null;
  }
  const code =
    `import(${JSON.stringify(api)}).then((tsx) => { tsx.register(); return import(${JSON.stringify(ts.href)}); })` +
    `.catch((err) => { setImmediate(() => { throw err; }); });\n`;
  return { url: ts, code };
}

/**
 * A small pool of worker threads, each with its own read-only connection. One op per worker
 * at a time. Waiting ops are served fairly between owners (users): a free worker takes the
 * oldest op of the owner served least recently, so one tenant queueing many slow queries
 * delays another tenant's query by at most one op per worker. Every op has a time budget (from enqueue): when it
 * runs out the op fails with 503 and its worker is terminated and replaced. The slot stays
 * occupied until the terminated thread has actually exited, so runaway queries can never
 * pile up more threads than the pool size.
 */
export class WorkerPool implements StatsExecutor {
  readonly mode = 'workers' as const;
  private readonly slots: Slot[];
  private readonly queue: Task[] = [];
  /** Dispatch sequence number of each owner's last op. */
  private readonly lastServed = new Map<string, number>();
  private served = 0;
  private nextId = 1;
  private started = false;
  private closed = false;

  constructor(
    private readonly dbPath: string,
    private readonly entry: WorkerEntry,
    size: number,
    private readonly timeoutMs: number,
    private readonly onError: (err: unknown) => void = () => {},
  ) {
    this.slots = Array.from({ length: Math.max(1, size) }, (_, index) => ({
      index,
      gen: 0,
      worker: null,
      task: null,
      dying: false,
      failures: 0,
    }));
  }

  get size(): number {
    return this.slots.length;
  }

  /** Threads currently alive (including terminated ones that have not exited yet). */
  get threads(): number {
    return this.slots.filter((s) => s.worker !== null).length;
  }

  run<K extends StatsOpKind>(op: OpOf<K>, pin?: Pin, owner = ''): Promise<Ran<StatsResults[K]>> {
    if (this.closed) return Promise.reject(unavailable());
    if (!this.started) {
      this.started = true;
      for (const s of this.slots) this.spawn(s);
    }
    if (pin && this.slots[pin.slot]?.gen !== pin.gen) {
      return Promise.reject(new Error('stats worker was restarted'));
    }
    return new Promise<Ran<StatsResults[K]>>((resolve, reject) => {
      const task: Task = {
        id: this.nextId++,
        op,
        pin,
        owner,
        resolve: resolve as (r: Ran<unknown>) => void,
        reject,
        timer: setTimeout(() => this.timeout(task), this.timeoutMs),
        slot: null,
      };
      task.timer.unref();
      this.queue.push(task);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.queue.splice(0)) this.fail(t, unavailable());
    const exits: Array<Promise<unknown>> = [];
    for (const s of this.slots) {
      if (s.task) this.fail(s.task, unavailable());
      s.task = null;
      if (s.worker) exits.push(s.worker.terminate());
    }
    await Promise.allSettled(exits);
    for (const s of this.slots) s.worker = null;
  }

  private spawn(slot: Slot): void {
    if (this.closed) return;
    slot.gen++;
    slot.dying = false;
    const gen = slot.gen;
    const worker = new Worker(this.entry.code ?? this.entry.url, {
      eval: this.entry.code !== undefined,
      workerData: { dbPath: this.dbPath },
      // the main connection holds the schema; workers only need a little heap for results
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    worker.unref();
    slot.worker = worker;
    worker.on('message', (msg: WorkerResponse | { ready: true }) => {
      if (slot.gen !== gen) return;
      if ('ready' in msg) {
        slot.failures = 0;
        return;
      }
      const task = slot.task;
      if (!task || task.id !== msg.id) return;
      slot.task = null;
      clearTimeout(task.timer);
      if (msg.ok) task.resolve({ value: msg.value, pin: { slot: slot.index, gen } });
      else if (msg.error.statusCode !== undefined) task.reject(new HttpError(msg.error.statusCode, msg.error.message));
      else task.reject(new Error(msg.error.message));
      this.dispatch();
    });
    worker.on('error', (err) => {
      // Uncaught error inside the worker (e.g. the database file cannot be opened).
      if (slot.gen !== gen) return;
      this.onError(err);
      slot.failures++;
      slot.dying = true;
      if (slot.task) this.fail(slot.task, new Error('stats worker failed'));
      slot.task = null;
    });
    worker.on('exit', () => {
      if (slot.worker === worker) slot.worker = null;
      if (this.closed) return;
      if (slot.gen !== gen && !slot.dying) return;
      if (slot.task) this.fail(slot.task, new Error('stats worker exited'));
      slot.task = null;
      slot.dying = true;
      // back off when a worker keeps failing on startup
      const delay = slot.failures > 0 ? Math.min(5000, 100 * 2 ** slot.failures) : 0;
      const t = setTimeout(() => {
        this.spawn(slot);
        this.dispatch();
      }, delay);
      t.unref();
    });
  }

  /** Bounded memory: drop owners with nothing queued (they rank like new owners again). */
  private forgetIdleOwners(): void {
    const queued = new Set(this.queue.map((t) => t.owner));
    for (const owner of this.lastServed.keys()) if (!queued.has(owner)) this.lastServed.delete(owner);
  }

  /** Index of the next task for a slot: oldest task of the least recently served owner. */
  private pick(slot: Slot): number {
    let best = -1;
    let bestServed = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i] as Task;
      if (t.pin && t.pin.slot !== slot.index) continue;
      const last = this.lastServed.get(t.owner) ?? -1;
      if (last < bestServed) {
        best = i;
        bestServed = last;
      }
    }
    return best;
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.task || slot.dying || !slot.worker) continue;
      const i = this.pick(slot);
      if (i === -1) continue;
      const task = this.queue.splice(i, 1)[0] as Task;
      this.lastServed.set(task.owner, ++this.served);
      if (this.lastServed.size > MAX_TRACKED_OWNERS) this.forgetIdleOwners();
      if (task.pin && task.pin.gen !== slot.gen) {
        this.fail(task, new Error('stats worker was restarted'));
        this.dispatch();
        return;
      }
      slot.task = task;
      task.slot = slot;
      const req: WorkerRequest = { id: task.id, op: task.op };
      slot.worker.postMessage(req);
    }
  }

  private timeout(task: Task): void {
    const qi = this.queue.indexOf(task);
    if (qi !== -1) {
      this.queue.splice(qi, 1);
      task.reject(queryTimedOut());
      return;
    }
    const slot = task.slot;
    if (!slot || slot.task !== task) return;
    slot.task = null;
    task.reject(queryTimedOut());
    // A synchronous SQLite query cannot be interrupted from outside: terminate the thread
    // (it exits as soon as the query returns) and replace it once it is gone.
    slot.dying = true;
    void slot.worker?.terminate();
  }

  private fail(task: Task, err: Error): void {
    clearTimeout(task.timer);
    task.reject(err);
  }
}

export interface ExecutorOptions {
  workers: number;
  queryTimeoutMs: number;
}

/** Workers for file databases; in-process for in-memory ones (tests) or when disabled. */
export function createExecutor(db: DB, opts: ExecutorOptions, log: { warn: (o: unknown, msg?: string) => void }): StatsExecutor {
  if (db.memory || db.name === ':memory:' || db.name === '' || opts.workers <= 0) return new InlineExecutor(db);
  const entry = resolveWorkerEntry();
  if (!entry) {
    log.warn({}, 'stats worker entry not found; running stats queries in-process');
    return new InlineExecutor(db);
  }
  return new WorkerPool(db.name, entry, opts.workers, opts.queryTimeoutMs, (err) => log.warn({ err }, 'stats worker error'));
}
