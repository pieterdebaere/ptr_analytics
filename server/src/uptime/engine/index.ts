// Uptime check engine (docs/SPEC.md §8.2, ANALYSIS §8.3).
//
// Runs on the main thread. Checks are network I/O through the async SafeNet (c-ares resolver,
// non-blocking sockets), so they do not occupy the event loop; the only synchronous work is the
// batched write (one short transaction every ~500 ms / 200 results) and small in-memory
// bookkeeping. A worker thread would need its own SQLite write connection (lock contention with
// ingest and the API, SQLITE_BUSY handling), message passing for every push / check-now / edit
// / SSE event, and a second copy of the secret box and network policy — more moving parts for
// no gain at the scale this targets. Every callback is guarded so a failing checker, listener or
// write can never crash the server.
import { isIP } from 'node:net';
import type { AppContext } from '../../context.js';
import { MaintenanceRepo } from '../data/maintenance.js';
import { MonitorRepo, type MonitorRecord } from '../data/monitors.js';
import { MaintenanceIndex } from '../maintenance/index.js';
import { rdapDomainExpiry } from '../checkers/registry.js';
import { createSafeNet, type TargetPolicyOptions } from '../net/index.js';
import { embeddedIPv4, formatIp, parseIp } from '../net/ip.js';
import { getSelfAddresses, selfAddressesReady, uptimeRuntime, type CheckerMap, type EngineControl } from '../runtime.js';
import type { CheckContext, CheckResult, SafeNet } from '../types.js';
import { CheckLimiter } from './limiter.js';
import { closeProcessor, processorFor, safeError, type ProcessorOptions, type ResultProcessor } from './processor.js';
import { Scheduler, nextSlotAfter, phaseOf, realClock, type EngineClock } from './scheduler.js';
import type { TransitionInput } from './transition.js';

export interface EngineHandle {
  stop(): Promise<void>;
}

export interface EngineOptions {
  clock?: EngineClock;
  checkers?: CheckerMap;
  netFactory?: (opts: TargetPolicyOptions) => SafeNet;
  processor?: ProcessorOptions;
  /** First runs after a restart are spread over min(interval, this). */
  startupSpreadMs?: number;
  groupDebounceMs?: number;
  /** Periodic reconciliation with the database (site suspension, edits from elsewhere). */
  resyncMs?: number;
  /** Maintenance start/end notifications check. */
  maintenanceTickMs?: number;
  watchdogGraceMs?: number;
  stopTimeoutMs?: number;
  perOwnerConcurrency?: number;
  /** Concurrent checks per (owner, destination). */
  perDestinationConcurrency?: number;
  /**
   * Checks per minute per destination across all hosted members (UPTIME_DEST_MAX_PER_MIN, default
   * 60; 0 = unlimited). Over budget, checks are deferred, never dropped. Operator monitors are not budgeted.
   */
  destMaxPerMin?: number;
  /**
   * Addresses that are always denied as member targets. Default: getSelfAddresses() (hosted mode:
   * local interfaces + PUBLIC_URL host, refreshed every 10 min; self-hosted: none).
   */
  selfAddresses?: string[];
  /** Resolved destination addresses are cached this long per monitor (per-destination limits). */
  destCacheMs?: number;
  /** RDAP lookup for monitors with domainNotify (tests inject a fake; default: checkers/domain). */
  domainLookup?: (net: SafeNet, host: string, signal: AbortSignal) => Promise<{ domain: string; expiresAt: number | null }>;
}

/** Domain expiry is looked up at most this often per domain (monitors with domainNotify). */
const DOMAIN_LOOKUP_MS = 12 * 3_600_000;

interface Entry {
  m: MonitorRecord;
  phase: number;
  intervalMs: number;
  /** Engine time of the last scheduled run (anchoring). */
  lastDue: number;
  running: boolean;
  /** Wall clock when the engine started tracking it (push grace period). */
  sinceWall: number;
  target: string | null;
  host: string | null;
  /** Normalised destination host (or IP literal) of the check. */
  dest: string | null;
  /** Resolved address of `dest` (hosted members), used as the limiter key; cached briefly. */
  destIp: { key: string; at: number } | null;
}

const PUSH_BUFFER_MS = 1000;
const NO_PUSH_MSG = 'No heartbeat in the time window';

export class Engine implements EngineControl, EngineHandle {
  private readonly clock: EngineClock;
  private readonly repo: MonitorRepo;
  private readonly maintRepo: MaintenanceRepo;
  private readonly maint: MaintenanceIndex;
  private readonly processor: ResultProcessor;
  private readonly scheduler: Scheduler;
  private readonly limiter: CheckLimiter;
  private readonly entries = new Map<number, Entry>();
  private readonly inFlight = new Map<number, { done: Promise<void>; abort: AbortController }>();
  private readonly timers = new Set<unknown>();
  private readonly nets = new Map<boolean, SafeNet>();
  /** The self address list the cached nets were built with (identity compare). */
  private netsSelf: readonly string[] | null = null;
  private readonly unsubs: Array<() => void> = [];
  private resyncTimer: NodeJS.Immediate | null = null;
  private readonly domainLookups = new Map<string, number>();
  private offset = 0;
  private startWall = 0;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: EngineOptions = {},
  ) {
    this.clock = opts.clock ?? realClock(ctx.now);
    this.repo = new MonitorRepo(ctx.db);
    this.maintRepo = new MaintenanceRepo(ctx.db);
    this.maint = new MaintenanceIndex(this.maintRepo);
    this.processor = processorFor(ctx, opts.processor);
    // The scheduler works in engine time (monotonic, wall aligned at start), not raw mono().
    const clock = this.clock;
    const engineClock: EngineClock = {
      wall: () => clock.wall(),
      mono: () => this.engineNow(),
      setTimer: (fn, ms) => clock.setTimer(fn, ms),
      clearTimer: (h) => clock.clearTimer(h),
    };
    this.scheduler = new Scheduler(engineClock, (id, due) => this.onDue(id, due));
    const cfg = ctx.config.uptime;
    this.limiter = new CheckLimiter(
      {
        global: cfg.checkConcurrency,
        perOwner: opts.perOwnerConcurrency ?? 4,
        perDestination: opts.perDestinationConcurrency ?? 2,
        destPerMinute: opts.destMaxPerMin ?? destMaxPerMinFromEnv(),
      },
      () => this.engineNow(),
      { set: (fn, ms) => this.clock.setTimer(fn, ms), clear: (h) => this.clock.clearTimer(h) },
    );
  }

  /** Hosted mode: checks of member monitors must never reach this server (see getSelfAddresses). */
  private selfList(): readonly string[] {
    return this.opts.selfAddresses ?? getSelfAddresses(this.ctx);
  }

  /** Checker definitions: injected, or the runtime's (read on use, so setCheckers() applies to a running engine). */
  private get checkers(): CheckerMap {
    return this.opts.checkers ?? uptimeRuntime(this.ctx).checkers;
  }

  /** Engine time: monotonic, aligned with the wall clock at start. */
  engineNow(): number {
    return this.clock.mono() - this.offset;
  }

  private wallToEngine(wall: number): number {
    return this.engineNow() + (wall - this.clock.wall());
  }

  start(): void {
    this.startWall = this.clock.wall();
    this.offset = this.clock.mono() - this.startWall;
    this.maint.reload();
    const now = this.engineNow();
    const spread = this.opts.startupSpreadMs ?? 30_000;
    for (const m of this.repo.schedulable()) {
      const e = this.track(m);
      if (!e) continue;
      this.scheduler.schedule(m.id, this.startupDue(e, now, spread));
    }
    this.unsubscribe = this.processor.onStatusChange((m) => {
      if (m.parentId !== null) this.groupSoon(m.parentId);
    });
    // Site deletions / suspensions (billing allowance) and account deletions take effect at once,
    // not only at the next periodic resync.
    this.unsubs.push(
      this.ctx.sites.onChange(() => this.resyncSoon()),
      this.ctx.users.onChange(() => this.resyncSoon()),
    );
    this.every(this.opts.resyncMs ?? 60_000, () => this.resync());
    this.every(this.opts.maintenanceTickMs ?? 30_000, () => this.maintenanceTick());
    uptimeRuntime(this.ctx).engine = this;
    // Hosted mode: no check runs before the server's own addresses are known (they are denied as
    // member targets). Checks scheduled meanwhile (startup, run-now, new monitors) simply wait.
    if (this.opts.selfAddresses !== undefined || !this.ctx.config.cloud.signupEnabled) this.scheduler.start();
    else {
      void selfAddressesReady(this.ctx).then(() => {
        if (!this.stopped) this.scheduler.start();
      });
    }
    this.ctx.log.info(`Uptime engine started (${this.entries.size} monitor(s)).`);
  }

  /** A promise that resolves once checks can run (tests, startup diagnostics). */
  ready(): Promise<void> {
    if (this.opts.selfAddresses !== undefined || !this.ctx.config.cloud.signupEnabled) return Promise.resolve();
    return selfAddressesReady(this.ctx);
  }

  private resyncSoon(): void {
    if (this.stopped || this.resyncTimer !== null) return;
    this.resyncTimer = setImmediate(() => {
      this.resyncTimer = null;
      if (!this.stopped) this.guard(() => this.resync());
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const rt = uptimeRuntime(this.ctx);
    if (rt.engine === this) rt.engine = null;
    this.scheduler.stop();
    for (const t of this.timers) this.clock.clearTimer(t);
    this.timers.clear();
    for (const u of this.unsubs.splice(0)) u();
    if (this.resyncTimer !== null) clearImmediate(this.resyncTimer);
    this.resyncTimer = null;
    this.unsubscribe?.();
    this.limiter.drain('engine stopping');
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(pending.map((p) => p.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.opts.stopTimeoutMs ?? 5000);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      for (const p of this.inFlight.values()) p.abort.abort();
    }
    closeProcessor(this.ctx);
  }

  // ---------------------------------------------------------------- EngineControl

  monitorChanged(id: number): void {
    if (this.stopped) return;
    this.guard(() => {
      const m = this.repo.byId(id);
      const old = this.entries.get(id);
      if (!m || !m.active || m.siteSuspended) {
        this.untrack(id);
        if (old?.m.parentId != null) this.groupSoon(old.m.parentId);
        return;
      }
      this.maint.reload();
      const e = this.track(m);
      if (!e) return;
      const now = this.engineNow();
      if (m.type === 'push') this.scheduler.schedule(id, this.pushDeadline(e));
      else this.scheduler.schedule(id, now); // new / edited / resumed monitors run once right away
      if (old && old.m.parentId !== null && old.m.parentId !== m.parentId) this.groupSoon(old.m.parentId);
      if (m.parentId !== null) this.groupSoon(m.parentId);
    });
  }

  maintenanceChanged(): void {
    if (this.stopped) return;
    this.guard(() => {
      this.maint.reload();
      this.reevaluateMaintenance();
      this.maintenanceTick();
    });
  }

  /**
   * Monitors whose maintenance state differs from their current status are re-evaluated within a
   * second (instead of waiting a full interval), so windows start and end on time.
   */
  private reevaluateMaintenance(): void {
    const wall = this.clock.wall();
    const soon = this.engineNow() + 1000;
    for (const e of this.entries.values()) {
      if (e.m.type === 'push' || e.running) continue;
      const inMaint = this.underMaintenance(e.m.id, wall);
      if ((this.processor.peekStatus(e.m.id) === 3) === inMaint) continue;
      const due = this.scheduler.dueOf(e.m.id);
      if (due === undefined || due > soon) this.scheduler.schedule(e.m.id, soon);
    }
  }

  checkNow(id: number): boolean {
    const e = this.entries.get(id);
    if (!e || this.stopped || e.m.type === 'push') return false;
    if (!e.running) this.scheduler.schedule(id, this.engineNow());
    return true;
  }

  push(id: number, input: { ok: boolean; msg: string; latencyMs: number | null }): void {
    this.guard(() => {
      const e = this.entries.get(id);
      const m = e?.m ?? this.repo.byId(id);
      if (!m) return;
      const wall = this.clock.wall();
      const inMaint = this.underMaintenance(id, wall);
      this.processor.record(m, { kind: 'check', ok: input.ok, msg: input.msg, latencyMs: input.latencyMs }, inMaint, {
        ts: wall,
        push: true,
        target: e?.target ?? null,
      });
      if (e && !this.stopped) {
        e.lastDue = this.engineNow();
        this.scheduler.schedule(id, this.pushDeadline(e));
      }
    });
  }

  manualChanged(id: number): void {
    this.monitorChanged(id);
  }

  // ---------------------------------------------------------------- scheduling

  private track(m: MonitorRecord): Entry | null {
    const intervalMs = Math.max(1, m.intervalS) * 1000;
    const def = this.checkers.get(m.type);
    let target: string | null = null;
    let host: string | null = null;
    try {
      target = def ? def.target(m.config) : null;
      host = def?.certHost ? def.certHost(m.config) : null;
    } catch {
      target = null;
    }
    const phase = phaseOf(m.uid, intervalMs);
    const dest = destinationOf(host ?? target);
    const prev = this.entries.get(m.id);
    if (prev) {
      // Update in place: a check may be running for this entry (its `running` flag and the
      // identity checks in reschedule() must stay valid).
      const destIp = prev.dest === dest && prev.m.ownerId === m.ownerId ? prev.destIp : null;
      Object.assign(prev, { m, phase, intervalMs, target, host, dest, destIp });
      return prev;
    }
    const e: Entry = {
      m,
      phase,
      intervalMs,
      lastDue: this.engineNow(),
      running: false,
      sinceWall: this.clock.wall(),
      target,
      host,
      dest,
      destIp: null,
    };
    this.entries.set(m.id, e);
    return e;
  }

  private untrack(id: number): void {
    this.entries.delete(id);
    this.scheduler.unschedule(id);
    this.processor.forget(id);
  }

  private startupDue(e: Entry, now: number, spreadMax: number): number {
    const m = e.m;
    if (m.type === 'push') return this.pushDeadline(e);
    const spread = phaseOf(`${m.uid}:start`, Math.max(1, Math.min(e.intervalMs, spreadMax)));
    if (m.type === 'group') return now + spread;
    const rt = this.processor.runtime(m);
    if (rt.lastBeatTs === null) return now + spread;
    const last = this.wallToEngine(rt.lastBeatTs);
    const next = rt.status === 2 ? last + m.retryIntervalS * 1000 : nextSlotAfter(last, e.phase, e.intervalMs);
    return next > now ? next : now + spread;
  }

  /** Wall time after which a missing push is a failure (grace of one interval after start / creation). */
  private noPushDeadline(e: Entry): number {
    const rt = this.processor.runtime(e.m);
    return Math.max(rt.lastPushAt ?? 0, this.startWall, e.sinceWall) + e.intervalMs + PUSH_BUFFER_MS;
  }

  /**
   * Next evaluation of a push monitor (engine time): the no-push deadline, and while the engine
   * itself records beats (failing / maintenance) every (retry) interval after the last beat, like Kuma.
   */
  private pushDeadline(e: Entry): number {
    const rt = this.processor.runtime(e.m);
    let wall = this.noPushDeadline(e);
    if (rt.lastBeatTs !== null && (rt.status === 0 || rt.status === 2 || rt.status === 3)) {
      wall = Math.max(wall, rt.lastBeatTs + (rt.status === 2 ? e.m.retryIntervalS * 1000 : e.intervalMs));
    }
    return this.wallToEngine(wall);
  }

  private nextDue(e: Entry, status: number, now: number): number {
    if (e.m.type === 'push') return this.pushDeadline(e);
    if (status === 2 && e.m.type !== 'group' && e.m.type !== 'manual') return now + e.m.retryIntervalS * 1000;
    return nextSlotAfter(Math.max(now, e.lastDue), e.phase, e.intervalMs);
  }

  private reschedule(e: Entry, status: number): void {
    if (this.stopped || this.entries.get(e.m.id) !== e) return;
    if (this.scheduler.has(e.m.id)) return; // re-scheduled meanwhile (edit, check-now, group debounce)
    this.scheduler.schedule(e.m.id, this.nextDue(e, status, this.engineNow()));
  }

  private groupSoon(groupId: number): void {
    const e = this.entries.get(groupId);
    if (!e || this.stopped) return;
    const at = this.engineNow() + (this.opts.groupDebounceMs ?? 1000);
    const due = this.scheduler.dueOf(groupId);
    if (due === undefined || due > at) this.scheduler.schedule(groupId, at);
  }

  private underMaintenance(id: number, wall: number): boolean {
    return this.maint.isUnderMaintenance(id, wall, (x) => this.entries.get(x)?.m.parentId ?? this.repoParent(x));
  }

  private parentCache = new Map<number, number | null>();
  private repoParent(id: number): number | null {
    // Ancestors that are not scheduled (paused groups) still pass their maintenance down.
    if (!this.parentCache.has(id)) {
      const r = this.ctx.db.prepare('SELECT parent_id FROM monitors WHERE id = ? AND deleted_at IS NULL').get(id) as { parent_id: number | null } | undefined;
      this.parentCache.set(id, r?.parent_id ?? null);
    }
    return this.parentCache.get(id) ?? null;
  }

  private onDue(id: number, due: number): void {
    const e = this.entries.get(id);
    if (!e || this.stopped) return;
    if (e.running) return; // the running check reschedules on completion
    e.lastDue = due;
    this.guard(() => {
      const m = e.m;
      const wall = this.clock.wall();
      const inMaint = this.underMaintenance(id, wall);
      if (m.type === 'push') return this.duePush(e, wall, inMaint);
      if (m.type === 'group') return this.finish(e, this.groupInput(e), inMaint, {});
      if (m.type === 'manual') {
        const st = m.manualStatus;
        const input: TransitionInput =
          st === 0 || st === 1 || st === 2
            ? { kind: 'custom', status: st, msg: m.manualMsg ?? (st === 1 ? 'Up' : st === 0 ? 'Down' : 'Pending') }
            : { kind: 'custom', status: 2, msg: 'No status set' };
        return this.finish(e, input, inMaint, {});
      }
      const def = this.checkers.get(m.type);
      if (!def || !def.check || (def.available && !def.available(this.ctx.config.uptime))) {
        return this.finish(e, { kind: 'check', ok: false, msg: 'Monitor type not available on this server' }, inMaint, {});
      }
      if (inMaint) return this.finish(e, { kind: 'check', ok: true, msg: '' }, true, {});
      this.submitCheck(e);
    });
  }

  private duePush(e: Entry, wall: number, inMaint: boolean): void {
    if (!inMaint && wall < this.noPushDeadline(e)) {
      // A push arrived in time (it recorded its own beat): just move the deadline.
      this.scheduler.schedule(e.m.id, this.pushDeadline(e));
      return;
    }
    this.finish(e, { kind: 'check', ok: false, msg: NO_PUSH_MSG }, inMaint, {});
  }

  private groupInput(e: Entry): TransitionInput {
    const children = [...this.entries.values()].filter((c) => c.m.parentId === e.m.id);
    if (children.length === 0) return { kind: 'custom', status: 2, msg: 'Group empty' };
    let status: 0 | 1 | 2 = 1;
    for (const c of children) {
      const st = this.processor.runtime(c.m).status;
      if (st === 0) {
        status = 0;
        break;
      }
      if (st === 2 || st === -1) status = 2;
    }
    return { kind: 'custom', status, msg: status === 1 ? 'All children up and running' : 'Child inaccessible' };
  }

  private finish(e: Entry, input: TransitionInput, inMaint: boolean, extra: { tls?: CheckResult['tls']; domainExpiresAt?: number | null }): void {
    let status: number = this.processor.runtime(e.m).status;
    try {
      const out = this.processor.record(e.m, input, inMaint, {
        ts: this.clock.wall(),
        target: e.target,
        host: e.host,
        tls: extra.tls,
        domainExpiresAt: extra.domainExpiresAt,
      });
      status = out.status;
    } catch (err) {
      this.ctx.log.error({ err: safeError(err), monitor: e.m.uid }, 'uptime: recording a result failed');
    }
    this.reschedule(e, status);
  }

  private hostedMember(m: MonitorRecord): boolean {
    return this.ctx.config.cloud.signupEnabled && m.ownerId !== null;
  }

  private submitCheck(e: Entry): void {
    e.running = true;
    const m = e.m;
    const member = this.hostedMember(m);
    // Hosted members: the destination is keyed by its resolved address, so different names of one
    // host (aliases, wildcard DNS, trailing dots, IP spellings) share its slots and budget.
    if (member && e.dest !== null && !isIP(e.dest)) {
      const cached = e.destIp;
      if (cached && this.clock.wall() - cached.at < (this.opts.destCacheMs ?? 5 * 60_000)) {
        this.enqueue(e, cached.key);
        return;
      }
      void this.resolveDest(e).then((key) => {
        if (this.stopped || this.entries.get(m.id) !== e) {
          e.running = false;
          return;
        }
        this.enqueue(e, key);
      });
      return;
    }
    this.enqueue(e, e.dest);
  }

  /** Resolved destination key (first address, canonical), or the host name when resolution fails. */
  private async resolveDest(e: Entry): Promise<string | null> {
    const host = e.dest as string;
    const ctrl = new AbortController();
    const t = this.clock.setTimer(() => ctrl.abort(), 5000);
    try {
      const r = await this.netFor(true).resolve(host, { signal: ctrl.signal });
      const first = r.addresses.map((a) => destinationOf(a.address)).filter((x): x is string => x !== null).sort()[0];
      const key = first ?? host;
      e.destIp = { key, at: this.clock.wall() };
      return key;
    } catch {
      // denied / unknown names fail fast in the check itself; keep the name as the key
      return host;
    } finally {
      this.clock.clearTimer(t);
    }
  }

  private enqueue(e: Entry, dest: string | null): void {
    const m = e.m;
    const member = this.hostedMember(m);
    const owner = member ? m.ownerId : null;
    this.limiter.submit({
      owner,
      dest,
      budgeted: member,
      deadline: this.engineNow() + e.intervalMs,
      drop: (reason) => {
        e.running = false;
        if (!this.stopped) this.ctx.log.warn({ monitor: m.uid }, `uptime: check skipped (${reason}); recorded as no data`);
        this.reschedule(e, this.processor.runtime(m).status);
      },
      start: (release) => {
        const abort = new AbortController();
        const done = this.runCheck(e, abort).finally(() => {
          this.inFlight.delete(m.id);
          e.running = false;
          release();
        });
        this.inFlight.set(m.id, { done, abort });
      },
    });
  }

  private async runCheck(e: Entry, ctrl: AbortController): Promise<void> {
    const m = e.m;
    const def = this.checkers.get(m.type);
    const started = this.clock.mono();
    let result: CheckResult;
    let secrets: Record<string, string> = {};
    const timers: unknown[] = [];
    try {
      if (!def?.check) throw new Error('Monitor type not available on this server');
      if (m.secrets) {
        try {
          secrets = this.ctx.secretBox().open(m.secrets, `monitor:${m.uid}`);
        } catch {
          throw new Error('Stored credentials cannot be decrypted (secrets key changed?)');
        }
      }
      const checkCtx: CheckContext = {
        monitorUid: m.uid,
        config: m.config,
        secrets,
        timeoutMs: m.timeoutMs,
        signal: ctrl.signal,
        net: this.netFor(this.hostedMember(m)),
        userAgent: this.ctx.config.uptime.userAgent,
        maxBodyBytes: this.ctx.config.uptime.maxBodyBytes,
        uptime: this.ctx.config.uptime,
      };
      const check = def.check;
      const watchdogMs = m.timeoutMs + (this.opts.watchdogGraceMs ?? 5000);
      result = await new Promise<CheckResult>((resolve, reject) => {
        timers.push(
          this.clock.setTimer(() => ctrl.abort(new Error(`Timeout after ${formatSeconds(m.timeoutMs)}`)), m.timeoutMs),
          this.clock.setTimer(() => {
            ctrl.abort();
            reject(new Error(`Timeout after ${formatSeconds(m.timeoutMs)} (watchdog)`));
          }, watchdogMs),
        );
        check(checkCtx).then(resolve, reject);
      });
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      const message = aborted ? `Timeout after ${formatSeconds(m.timeoutMs)}` : err instanceof Error ? err.message : 'Check failed';
      result = { status: 'down', msg: message || 'Check failed' };
      if (!aborted && !(err instanceof Error)) this.ctx.log.warn({ monitor: m.uid }, 'uptime: checker threw a non-error value');
    } finally {
      for (const t of timers) this.clock.clearTimer(t);
      if (!ctrl.signal.aborted) ctrl.abort();
    }
    if (this.stopped && this.entries.get(m.id) !== e) return;
    const latency = typeof result.latencyMs === 'number' ? result.latencyMs : this.clock.mono() - started;
    const msg = scrubSecrets(typeof result.msg === 'string' ? result.msg : '', secrets);
    // The monitor may have been edited / removed while the check ran.
    const current = this.entries.get(m.id);
    if (!current) return;
    const inMaint = this.underMaintenance(m.id, this.clock.wall());
    this.finish(current, { kind: 'check', ok: result.status === 'up', msg, latencyMs: latency }, inMaint, {
      tls: result.tls,
      domainExpiresAt: result.domainExpiresAt ?? null,
    });
    if (m.domainNotify && m.type !== 'domain' && current.host && result.domainExpiresAt === undefined) this.maybeLookupDomain(current);
  }

  /** Background RDAP lookup (at most every 12 h per host) for domain expiry notices. */
  private maybeLookupDomain(e: Entry): void {
    const host = e.host;
    if (!host || isIP(host) || this.stopped) return;
    const now = this.clock.wall();
    const last = this.domainLookups.get(host);
    if (last !== undefined && now - last < DOMAIN_LOOKUP_MS) return;
    if (this.domainLookups.size > 10_000) this.domainLookups.clear();
    this.domainLookups.set(host, now);
    const lookup = this.opts.domainLookup ?? rdapDomainExpiry;
    const ctrl = new AbortController();
    const t = this.clock.setTimer(() => ctrl.abort(), 15_000);
    let net: SafeNet;
    try {
      net = this.netFor(this.hostedMember(e.m));
    } catch {
      this.clock.clearTimer(t);
      return;
    }
    lookup(net, host, ctrl.signal)
      .then((r) => {
        if (r.expiresAt !== null && !this.stopped && this.entries.has(e.m.id)) this.processor.recordDomainExpiry(e.m, r.domain, r.expiresAt, e.target);
      })
      .catch(() => {
        // RDAP is best effort (unsupported TLDs, rate limits)
      })
      .finally(() => this.clock.clearTimer(t));
  }

  /**
   * SafeNet for checks (and RDAP lookups) of operator / member monitors. In hosted mode the
   * server's own addresses are denied (self-hosted: none, documented in §8.1); the nets are
   * rebuilt whenever the periodically refreshed self address list changes.
   */
  private netFor(hostedMember: boolean): SafeNet {
    const self = this.selfList();
    if (self !== this.netsSelf) {
      this.nets.clear();
      this.netsSelf = self;
    }
    let net = this.nets.get(hostedMember);
    if (!net) {
      const factory = this.opts.netFactory ?? createSafeNet;
      net = factory({ config: this.ctx.config.uptime, selfAddresses: self, hostedMember });
      this.nets.set(hostedMember, net);
    }
    return net;
  }

  // ---------------------------------------------------------------- periodic work

  private every(ms: number, fn: () => void): void {
    const loop = (): void => {
      if (this.stopped) return;
      this.guard(fn);
      const t = this.clock.setTimer(() => {
        this.timers.delete(t);
        loop();
      }, ms);
      this.timers.add(t);
    };
    const t = this.clock.setTimer(() => {
      this.timers.delete(t);
      loop();
    }, ms);
    this.timers.add(t);
  }

  /** Reconcile with the database: new / removed / edited monitors, suspended or deleted sites. */
  resync(): void {
    this.parentCache.clear();
    this.maint.reload();
    const live = new Map(this.repo.schedulable().map((m) => [m.id, m]));
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.untrack(id);
    const now = this.engineNow();
    for (const m of live.values()) {
      const e = this.entries.get(m.id);
      if (e && e.m.updatedAt === m.updatedAt) {
        e.m = { ...m }; // site name / owner may have changed
        continue;
      }
      const tracked = this.track(m);
      if (!tracked) continue;
      if (!e) this.scheduler.schedule(m.id, this.startupDue(tracked, now, this.opts.startupSpreadMs ?? 30_000));
      else this.scheduler.schedule(m.id, m.type === 'push' ? this.pushDeadline(tracked) : now);
    }
  }

  /**
   * maint_start / maint_end notifications (once per window, persisted across restarts). Cheap:
   * active maintenances come from the in-memory index (window lookups cached), the database is
   * only asked for paused maintenances whose window was announced and must still be closed.
   */
  maintenanceTick(): void {
    const wall = this.clock.wall();
    this.reevaluateMaintenance();
    const list = [...this.maint.active(), ...this.maintRepo.listPausedAnnounced()];
    const due: Array<{ m: (typeof list)[number]; start: number | null }> = [];
    for (const m of list) {
      const w = m.active ? this.maint.window(m, wall) : null;
      const start = w ? w.start : null;
      if (start !== m.notifiedStart) due.push({ m, start });
    }
    if (due.length === 0) return;
    // One transaction for all bookkeeping writes of this tick.
    this.ctx.db.transaction(() => {
      for (const { m, start } of due) {
        const monitorIds = this.maintRepo.monitorIds(m.id);
        if (start !== null && m.notifiedStart !== null) {
          // a new window while the previous one was never closed: close it first
          this.processor.maintenanceNotice('maint_end', m, monitorIds);
        }
        this.processor.maintenanceNotice(start !== null ? 'maint_start' : 'maint_end', m, monitorIds);
        this.maintRepo.setNotifiedStart(m.id, start);
      }
    })();
    for (const { m, start } of due) m.notifiedStart = start; // the index keeps these records until its next reload
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.ctx.log.error({ err: safeError(err) }, 'uptime engine error');
    }
  }

  /** Diagnostics / tests. */
  stats(): { monitors: number; inFlight: number; queued: number } {
    return { monitors: this.entries.size, inFlight: this.limiter.active, queued: this.limiter.queued };
  }

  dueOf(id: number): number | undefined {
    return this.scheduler.dueOf(id);
  }
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/** Remove secret values a checker might have echoed into its message. */
export function scrubSecrets(msg: string, secrets: Record<string, string>): string {
  let out = msg;
  for (const v of Object.values(secrets)) {
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}

/**
 * Destination key for the per-destination limits: the host of a URL / host:port / host, lower-case
 * without trailing dots; IP literals in canonical form, IPv6 embeddings of IPv4 (mapped, NAT64 …)
 * as the IPv4 address, so different spellings of one destination share one key.
 */
export function destinationOf(target: string | null): string | null {
  if (!target) return null;
  let host: string | null;
  try {
    if (target.includes('://')) host = new URL(target).hostname.toLowerCase() || null;
    else {
      const t = target.trim().toLowerCase();
      if (t.startsWith('[')) host = t.slice(1, t.indexOf(']') > 0 ? t.indexOf(']') : undefined) || null;
      else if (isIP(t) === 6) host = t;
      else {
        const colon = t.indexOf(':');
        host = colon > 0 && t.indexOf(':', colon + 1) === -1 ? t.slice(0, colon) : t.split('/')[0] || null;
      }
    }
  } catch {
    return null;
  }
  if (!host) return null;
  host = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return null;
  const ip = parseIp(host);
  if (ip) return formatIp(embeddedIPv4(ip) ?? ip);
  return host;
}

/** UPTIME_DEST_MAX_PER_MIN (default 60, 0 = unlimited): member checks per destination per minute. */
export function destMaxPerMinFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env['UPTIME_DEST_MAX_PER_MIN']?.trim();
  if (raw === undefined || raw === '') return 60;
  if (!/^\d{1,6}$/.test(raw)) return 60;
  return Number(raw);
}

/** Create and start an engine (tests pass fakes through `opts`). */
export function createEngine(ctx: AppContext, opts: EngineOptions = {}): Engine {
  const engine = new Engine(ctx, opts);
  engine.start();
  return engine;
}

/** Start the scheduler/check engine (only when background jobs run). */
export async function startEngine(ctx: AppContext): Promise<EngineHandle> {
  try {
    return createEngine(ctx);
  } catch (err) {
    ctx.log.error({ err: safeError(err) }, 'uptime engine failed to start; monitoring is disabled');
    return { stop: async () => closeProcessor(ctx) };
  }
}
