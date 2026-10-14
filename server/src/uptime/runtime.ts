// Per-AppContext runtime of the uptime module: the in-process event bus (SSE), the checker
// registry in use (injectable for tests), the running engine and the result processor.
import { Resolver } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import os from 'node:os';
import type { AppContext } from '../context.js';
import { CHECKERS } from './checkers/registry.js';
import type { CheckerDefinition } from './types.js';

export interface BeatEvent {
  uid: string;
  siteId: string;
  /** Owner of the monitor's site when the beat was recorded (null = operator site). Informational: the SSE stream re-checks access with the site's current owner. */
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

interface SelfState {
  /** Current list (frozen; replaced, never mutated, so identity changes signal a refresh). */
  addresses: readonly string[];
  /** Wall clock of the last completed computation (0 = never). */
  at: number;
  /** Running computation. */
  pending: Promise<void> | null;
  /** First computation finished. */
  ready: Promise<void>;
  /** Fixed list injected by tests / setSelfAddresses (never refreshed). */
  fixed: boolean;
}

export interface UptimeRuntime {
  bus: UptimeBus;
  checkers: CheckerMap;
  engine: EngineControl | null;
  /** Lazily created result processor (shared by the engine and the push/manual API paths). */
  processor: unknown;
  /** The server's own addresses (hosted mode SSRF guard), see getSelfAddresses(). */
  self: SelfState | null;
}

const runtimes = new WeakMap<AppContext, UptimeRuntime>();

export function uptimeRuntime(ctx: AppContext): UptimeRuntime {
  let rt = runtimes.get(ctx);
  if (!rt) {
    const emitter = new EventEmitter();
    // One listener per SSE connection; the connection limits bound this.
    emitter.setMaxListeners(0);
    rt = { bus: emitter as unknown as UptimeBus, checkers: CHECKERS, engine: null, processor: null, self: null };
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

// ---------------------------------------------------------------- the server's own addresses

/** Self addresses are recomputed (in the background) when older than this. */
export const SELF_REFRESH_MS = 10 * 60_000;
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * Hosted mode only (docs/SPEC.md §8.1): the addresses of this server — every local interface plus
 * the resolved addresses of the PUBLIC_URL host — which member-controlled traffic (monitors,
 * notifications, RDAP) must never reach: traffic to the host's own public IP is delivered over
 * the loopback interface and would bypass firewalls that only filter the external interface.
 *
 * Self-hosted installs return an empty list (documented decision: operators may monitor sites
 * behind the same reverse proxy, and admins configure their own targets anyway).
 *
 * Synchronous, from the cache: the list is computed once at startup (see selfAddressesReady(),
 * which the engine awaits before it starts checking) and refreshed in the background every
 * SELF_REFRESH_MS. The returned array is frozen and replaced on refresh, so a caller can compare
 * identities to know when to rebuild a SafeNet. Pass it as `selfAddresses` to createSafeNet().
 */
export function getSelfAddresses(ctx: AppContext): readonly string[] {
  if (!ctx.config.cloud.signupEnabled) return EMPTY;
  const st = selfState(ctx);
  if (!st.fixed && st.pending === null && st.at > 0 && ctx.now() - st.at >= SELF_REFRESH_MS) refreshSelf(ctx, st);
  return st.addresses;
}

/** Resolves once the self address list has been computed at least once (immediately when self-hosted). */
export function selfAddressesReady(ctx: AppContext): Promise<void> {
  if (!ctx.config.cloud.signupEnabled) return Promise.resolve();
  return selfState(ctx).ready;
}

/** Dependency injection (tests) and operator overrides: use this fixed list (no refresh). */
export function setSelfAddresses(ctx: AppContext, addresses: readonly string[]): void {
  const rt = uptimeRuntime(ctx);
  rt.self = { addresses: Object.freeze([...addresses]), at: ctx.now(), pending: null, ready: Promise.resolve(), fixed: true };
}

function selfState(ctx: AppContext): SelfState {
  const rt = uptimeRuntime(ctx);
  if (rt.self) return rt.self;
  const st: SelfState = { addresses: EMPTY, at: 0, pending: null, ready: Promise.resolve(), fixed: false };
  rt.self = st;
  st.ready = refreshSelf(ctx, st);
  return st;
}

function refreshSelf(ctx: AppContext, st: SelfState): Promise<void> {
  const p = computeSelfAddresses(ctx.config.publicUrl)
    .then((list) => {
      if (st.fixed) return;
      // Never shrink to nothing on a transient DNS failure: keep the PUBLIC_URL addresses known so far.
      const merged = new Set(list);
      if (st.at > 0 && list.length < st.addresses.length) for (const a of st.addresses) merged.add(a);
      st.addresses = Object.freeze([...merged].sort());
      st.at = ctx.now();
    })
    .catch(() => {
      st.at = ctx.now();
    })
    .finally(() => {
      st.pending = null;
    });
  st.pending = p;
  return p;
}

/** Local interface addresses + the PUBLIC_URL host (IP literal, or its A/AAAA records). Never rejects. */
export async function computeSelfAddresses(publicUrl: string | null, resolver?: Pick<Resolver, 'resolve4' | 'resolve6'>): Promise<string[]> {
  const addrs = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) addrs.add(a.address.split('%')[0] as string);
  } catch {
    // no interface information (sandboxes)
  }
  if (publicUrl) {
    try {
      const host = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
      if (isIP(host)) addrs.add(host);
      else if (host) {
        const r = resolver ?? new Resolver({ timeout: 3000, tries: 2 });
        const [v4, v6] = await Promise.allSettled([r.resolve4(host), r.resolve6(host)]);
        if (v4.status === 'fulfilled') v4.value.forEach((a) => addrs.add(a));
        if (v6.status === 'fulfilled') v6.value.forEach((a) => addrs.add(a));
      }
    } catch {
      // best effort
    }
  }
  addrs.delete('');
  return [...addrs];
}
