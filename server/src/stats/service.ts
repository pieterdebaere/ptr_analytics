import type { AppContext } from '../context.js';
import { HttpError } from '../lib/errors.js';
import type { ExportBatch, ExportSpec } from './export.js';
import type { OpOf, StatsOpKind, StatsResults } from './ops.js';
import { createExecutor, type Pin, type StatsExecutor } from './pool.js';

export interface StatsServiceOptions {
  /** Worker threads for stats queries (STATS_WORKERS, default 2; 0 = run in-process). */
  workers: number;
  /** Time budget per query incl. queue wait (STATS_QUERY_TIMEOUT_MS, default 30 s). */
  queryTimeoutMs: number;
  /** Result cache TTL (STATS_CACHE_TTL_MS, default 15 s; 0 disables the cache). */
  cacheTtlMs: number;
  cacheMaxEntries: number;
  /** Stats requests running or queued, over all users; beyond this: 429. */
  maxInFlight: number;
  /** Stats requests running or queued per user; beyond this: 429. */
  maxInFlightPerUser: number;
  maxExports: number;
  maxExportsPerUser: number;
  /**
   * Global query slots kept free for users with nothing in flight: a user's second and further
   * concurrent requests are refused once fewer than this many slots are left (at most a
   * quarter of maxInFlight), so a few busy tenants cannot lock everybody else out.
   */
  reservedInFlight: number;
  /** An export whose client reads nothing for this long is aborted (slot freed). */
  exportIdleTimeoutMs: number;
  /** No export runs longer than this. */
  exportMaxDurationMs: number;
}

export const DEFAULT_STATS_OPTIONS: StatsServiceOptions = {
  workers: 2,
  queryTimeoutMs: 30_000,
  cacheTtlMs: 15_000,
  cacheMaxEntries: 500,
  maxInFlight: 32,
  maxInFlightPerUser: 6,
  maxExports: 2,
  maxExportsPerUser: 1,
  reservedInFlight: 8,
  exportIdleTimeoutMs: 30_000,
  exportMaxDurationMs: 10 * 60_000,
};

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw)) return def;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function statsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): StatsServiceOptions {
  return {
    ...DEFAULT_STATS_OPTIONS,
    workers: intEnv(env, 'STATS_WORKERS', DEFAULT_STATS_OPTIONS.workers, 0, 16),
    queryTimeoutMs: intEnv(env, 'STATS_QUERY_TIMEOUT_MS', DEFAULT_STATS_OPTIONS.queryTimeoutMs, 100, 600_000),
    cacheTtlMs: intEnv(env, 'STATS_CACHE_TTL_MS', DEFAULT_STATS_OPTIONS.cacheTtlMs, 0, 600_000),
    exportIdleTimeoutMs: intEnv(env, 'STATS_EXPORT_IDLE_TIMEOUT_MS', DEFAULT_STATS_OPTIONS.exportIdleTimeoutMs, 1000, 3_600_000),
    exportMaxDurationMs: intEnv(env, 'STATS_EXPORT_MAX_DURATION_MS', DEFAULT_STATS_OPTIONS.exportMaxDurationMs, 1000, 24 * 3_600_000),
  };
}

export const tooManyRequests = (): HttpError => new HttpError(429, 'too many requests');

/** Results larger than this (serialised) are not cached. */
const MAX_CACHED_SIZE = 512 * 1024;
/** Total (approximate) bytes held by the cache. */
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

interface CacheEntry {
  expires: number;
  size: number;
  value: Promise<unknown>;
}

/** Small TTL + LRU result cache; concurrent identical requests share one query. */
class ResultCache {
  private readonly map = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): Promise<unknown> | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.clock()) {
      this.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Stores the pending promise right away (coalescing); drops it if it fails or is too big. */
  set(key: string, value: Promise<unknown>): void {
    this.delete(key);
    const entry: CacheEntry = {
      expires: this.clock() + this.ttlMs,
      size: key.length,
      value,
    };
    this.map.set(key, entry);
    this.bytes += entry.size;
    value.then(
      (v) => {
        if (this.map.get(key) !== entry) return;
        let size: number;
        try {
          size = key.length + JSON.stringify(v).length;
        } catch {
          size = Infinity;
        }
        if (size > MAX_CACHED_SIZE) {
          this.delete(key);
          return;
        }
        this.bytes += size - entry.size;
        entry.size = size;
        // the TTL counts from completion, so a slow query is still served from cache afterwards
        entry.expires = this.clock() + this.ttlMs;
        this.evict();
      },
      () => {
        if (this.map.get(key) === entry) this.delete(key);
      },
    );
    this.evict();
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  private delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.size;
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || (this.bytes > MAX_CACHE_BYTES && this.map.size > 1)) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}

/**
 * Concurrency counter: global + per key, with `reserved` global slots that only a key with
 * nothing in flight may take (fairness between tenants).
 */
export class Limiter {
  private total = 0;
  private readonly perKey = new Map<string, number>();
  private readonly reserved: number;

  constructor(
    private readonly max: number,
    private readonly maxPerKey: number,
    reserved = 0,
  ) {
    this.reserved = Math.max(0, Math.min(reserved, Math.floor(max / 4)));
  }

  /** Returns a release function, or null when a limit is reached. */
  tryAcquire(key: string): (() => void) | null {
    const mine = this.perKey.get(key) ?? 0;
    if (this.total >= this.max || mine >= this.maxPerKey) return null;
    if (mine > 0 && this.total >= this.max - this.reserved) return null;
    this.total++;
    this.perKey.set(key, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const n = (this.perKey.get(key) ?? 1) - 1;
      if (n <= 0) this.perKey.delete(key);
      else this.perKey.set(key, n);
    };
  }

  get inFlight(): number {
    return this.total;
  }
}

export type ExportAbortReason = 'idle' | 'duration';

/**
 * One running export: keyset cursor on one connection. A watchdog aborts it (freeing the
 * export slot and the cursor) when the client stops reading — no page requested for
 * `idleMs` while none is being fetched — or when it has run for `maxMs` in total, so a
 * slow or stalled client can never hold one of the few export slots indefinitely.
 */
export class ExportSession {
  private closed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly maxTimer: NodeJS.Timeout;
  private abortHandler: ((reason: ExportAbortReason) => void) | null = null;
  /** Why the watchdog stopped this export, or null. */
  aborted: ExportAbortReason | null = null;

  constructor(
    private readonly executor: StatsExecutor,
    private readonly handle: number,
    private readonly pin: Pin,
    private readonly release: () => void,
    private readonly owner: string = '',
    private readonly limits: { idleMs: number; maxMs: number } = {
      idleMs: DEFAULT_STATS_OPTIONS.exportIdleTimeoutMs,
      maxMs: DEFAULT_STATS_OPTIONS.exportMaxDurationMs,
    },
  ) {
    this.maxTimer = setTimeout(() => this.abort('duration'), limits.maxMs);
    this.maxTimer.unref();
    this.armIdle();
  }

  /** Called (once) when the watchdog aborts the export; the caller ends the response. */
  onAbort(fn: (reason: ExportAbortReason) => void): void {
    this.abortHandler = fn;
    if (this.aborted !== null) fn(this.aborted);
  }

  async next(): Promise<ExportBatch> {
    if (this.closed) return { csv: '', rows: 0, done: true };
    this.disarmIdle();
    try {
      const { value } = await this.executor.run<'exportNext'>({ kind: 'exportNext', handle: this.handle }, this.pin, this.owner);
      if (value.done) this.close(false);
      return value;
    } finally {
      this.armIdle();
    }
  }

  /** Idempotent; frees the export slot and the cursor (and its TEMP table). */
  close(dropCursor = true): void {
    if (this.closed) return;
    this.closed = true;
    this.disarmIdle();
    clearTimeout(this.maxTimer);
    this.release();
    if (dropCursor) {
      this.executor.run<'exportClose'>({ kind: 'exportClose', handle: this.handle }, this.pin, this.owner).catch(() => {
        // worker gone or closing: its cursors are gone with it
      });
    }
  }

  private abort(reason: ExportAbortReason): void {
    if (this.closed) return;
    this.aborted = reason;
    this.close();
    this.abortHandler?.(reason);
  }

  private armIdle(): void {
    this.disarmIdle();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => this.abort('idle'), this.limits.idleMs);
    this.idleTimer.unref();
  }

  private disarmIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Off-main-thread execution, admission control and short-lived result caching for the
 * dashboard's heavy read endpoints (stats, speed insights, overview, export).
 */
export class StatsService {
  readonly executor: StatsExecutor;
  private readonly cache: ResultCache;
  private readonly requests: Limiter;
  private readonly exports: Limiter;

  constructor(
    ctx: Pick<AppContext, 'db' | 'log'>,
    readonly options: StatsServiceOptions = statsOptionsFromEnv(),
  ) {
    this.executor = createExecutor(ctx.db, options, ctx.log);
    this.cache = new ResultCache(options.cacheTtlMs, options.cacheMaxEntries);
    this.requests = new Limiter(options.maxInFlight, options.maxInFlightPerUser, options.reservedInFlight);
    // maxExportsPerUser (1) of maxExports (2): one user can never hold every export slot.
    this.exports = new Limiter(options.maxExports, options.maxExportsPerUser);
  }

  /** Run one op for a user (429 when over the limits), served from cache when possible. */
  async query<K extends StatsOpKind>(userKey: string, op: OpOf<K>, opts: { cache?: boolean } = {}): Promise<StatsResults[K]> {
    const useCache = this.cache.enabled && opts.cache !== false;
    const key = useCache ? JSON.stringify(op) : '';
    if (useCache) {
      const hit = this.cache.get(key);
      if (hit) return (await hit) as StatsResults[K];
    }
    const release = this.requests.tryAcquire(userKey);
    if (!release) throw tooManyRequests();
    const p = this.executor.run<K>(op, undefined, userKey).then((r) => r.value);
    if (useCache) this.cache.set(key, p);
    try {
      return await p;
    } finally {
      release();
    }
  }

  /** Start an export (429 when over the export limits). */
  async openExport(userKey: string, spec: ExportSpec): Promise<ExportSession> {
    const release = this.exports.tryAcquire(userKey);
    if (!release) throw tooManyRequests();
    try {
      const { value, pin } = await this.executor.run<'exportOpen'>({ kind: 'exportOpen', spec }, undefined, userKey);
      return new ExportSession(this.executor, value, pin, release, userKey, {
        idleMs: this.options.exportIdleTimeoutMs,
        maxMs: this.options.exportMaxDurationMs,
      });
    } catch (err) {
      release();
      throw err;
    }
  }

  get inFlight(): number {
    return this.requests.inFlight;
  }

  get exportsInFlight(): number {
    return this.exports.inFlight;
  }

  clearCache(): void {
    this.cache.clear();
  }

  async close(): Promise<void> {
    this.cache.clear();
    await this.executor.close();
  }
}

const services = new WeakMap<object, StatsService>();

/** The StatsService of an app context (created on first use, one per context). */
export function statsService(ctx: AppContext, options?: Partial<StatsServiceOptions>): StatsService {
  let s = services.get(ctx);
  if (!s) {
    s = new StatsService(ctx, { ...statsOptionsFromEnv(), ...options });
    services.set(ctx, s);
  }
  return s;
}
