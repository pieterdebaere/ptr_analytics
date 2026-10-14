// Per-AppContext runtime of the uptime module: the in-process event bus (SSE), the checker
// registry in use (injectable for tests), the running engine and the result processor.
import { EventEmitter } from 'node:events';
import type { AppContext } from '../context.js';
import { CHECKERS } from './checkers/registry.js';
import type { CheckerDefinition } from './types.js';

export interface BeatEvent {
  uid: string;
  siteId: string;
  /** Owner of the monitor's site (null = operator site); used for SSE access filtering. */
  ownerId: number | null;
  ts: number;
  status: number;
  latencyMs: number | null;
  msg: string | null;
}

export interface StateEvent {
  uid: string;
  siteId: string;
  ownerId: number | null;
  status: number;
  since: number;
}

export interface UptimeBus {
  on(event: 'beat', fn: (e: BeatEvent) => void): void;
  on(event: 'state', fn: (e: StateEvent) => void): void;
  off(event: 'beat', fn: (e: BeatEvent) => void): void;
  off(event: 'state', fn: (e: StateEvent) => void): void;
  emit(event: 'beat', e: BeatEvent): void;
  emit(event: 'state', e: StateEvent): void;
  listenerCount(event: 'beat' | 'state'): number;
}

/** What the API needs from a running engine. */
export interface EngineControl {
  /** A monitor was created / edited / paused / resumed / deleted: reload it. */
  monitorChanged(id: number): void;
  /** Maintenance windows or links changed. */
  maintenanceChanged(): void;
  /** Run a check as soon as possible. False when the monitor is not scheduled. */
  checkNow(id: number): boolean;
  /** A push arrived (push monitors). */
  push(id: number, input: { ok: boolean; msg: string; latencyMs: number | null }): void;
  /** Manual monitor status changed. */
  manualChanged(id: number): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CheckerMap = ReadonlyMap<string, CheckerDefinition<any, any>>;

export interface UptimeRuntime {
  bus: UptimeBus;
  checkers: CheckerMap;
  engine: EngineControl | null;
  /** Lazily created result processor (shared by the engine and the push/manual API paths). */
  processor: unknown;
}

const runtimes = new WeakMap<AppContext, UptimeRuntime>();

export function uptimeRuntime(ctx: AppContext): UptimeRuntime {
  let rt = runtimes.get(ctx);
  if (!rt) {
    const emitter = new EventEmitter();
    // One listener per SSE connection; the connection limits bound this.
    emitter.setMaxListeners(0);
    rt = { bus: emitter as unknown as UptimeBus, checkers: CHECKERS, engine: null, processor: null };
    runtimes.set(ctx, rt);
  }
  return rt;
}

/** Dependency injection (tests): use these checker definitions instead of the registry. */
export function setCheckers(ctx: AppContext, checkers: CheckerMap): void {
  uptimeRuntime(ctx).checkers = checkers;
}

export function checkersOf(ctx: AppContext): CheckerMap {
  return uptimeRuntime(ctx).checkers;
}
