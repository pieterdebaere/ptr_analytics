// Result processing: transition → heartbeat, state, aggregates, events, outages, TLS / expiry
// notices and notify_outbox rows (queued for the batch writer), plus live events for SSE.
import type { AppContext } from '../../context.js';
import { cleanText } from '../../lib/text.js';
import { MonitorRepo, type MonitorRecord, type StateRecord } from '../data/monitors.js';
import { uptimeRuntime, type UptimeBus } from '../runtime.js';
import { statusName, type NotifyEvent, type NotifyPayload, type TlsInfo } from '../types.js';
import { DAY_MS, HOUR_MS, beatContributions, gapCapMs } from './aggregate.js';
import { transition, type EngineStatus, type TransitionInput, type TransitionOutput } from './transition.js';
import { BatchWriter, type Statements, type WriteOp } from './writer.js';

/** Certificate / domain expiry notice thresholds (days), each sent once per certificate. */
export const EXPIRY_THRESHOLDS = [21, 14, 7, 3, 1] as const;

export const MSG_MAX = 200;

interface OutageHolder {
  id: number | null;
  startedAt: number;
}

export interface MonitorRuntime {
  status: EngineStatus;
  retries: number;
  failedSinceNotify: number;
  lastBeatTs: number | null;
  lastChangeAt: number | null;
  lastPushAt: number | null;
  lastLatencyMs: number | null;
  lastMsg: string | null;
  outage: OutageHolder | null;
  outageConfirmed: boolean;
}

export interface RecordExtra {
  /** Wall clock of the result; default ctx.now(). */
  ts?: number;
  tls?: TlsInfo | undefined;
  domainExpiresAt?: number | null | undefined;
  /** Host for TLS / domain notices. */
  host?: string | null;
  /** Display target for notification payloads. */
  target?: string | null;
  /** The result is a received push (updates last_push_at). */
  push?: boolean;
}

export interface ProcessorOptions {
  flushMs?: number;
  maxBatch?: number;
}

export type StatusChangeListener = (m: MonitorRecord, prev: number, next: number) => void;

export function expiryThresholdsCrossed(daysLeft: number): number[] {
  return EXPIRY_THRESHOLDS.filter((t) => daysLeft <= t);
}

export class ResultProcessor {
  readonly writer: BatchWriter;
  private readonly states = new Map<number, MonitorRuntime>();
  private readonly repo: MonitorRepo;
  private readonly bus: UptimeBus;
  private readonly listeners = new Set<StatusChangeListener>();

  constructor(
    private readonly ctx: AppContext,
    opts: ProcessorOptions = {},
  ) {
    this.repo = new MonitorRepo(ctx.db);
    this.bus = uptimeRuntime(ctx).bus;
    this.writer = new BatchWriter(ctx.db, {
      flushMs: opts.flushMs ?? 500,
      maxBatch: opts.maxBatch ?? 200,
      maxQueued: 50_000,
      onError: (err) => ctx.log.error({ err: safeError(err) }, 'uptime: writing check results failed'),
    });
  }

  onStatusChange(fn: StatusChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** In-memory state of a monitor (loaded from monitor_state on first use). */
  runtime(m: { id: number }): MonitorRuntime {
    let rt = this.states.get(m.id);
    if (!rt) {
      rt = fromRecord(this.repo.state(m.id), this.ctx);
      this.states.set(m.id, rt);
    }
    return rt;
  }

  /** Current status without loading (null when unknown to the processor). */
  peekStatus(id: number): number | null {
    return this.states.get(id)?.status ?? null;
  }

  forget(id: number): void {
    this.states.delete(id);
  }

  /** Remember a received push (also when the push is processed as a beat). */
  notePush(m: MonitorRecord, ts: number): void {
    this.runtime(m).lastPushAt = ts;
  }

  /**
   * Process one result. `input` is ignored while `inMaintenance`. Returns the transition (tests,
   * engine scheduling decisions).
   */
  record(m: MonitorRecord, input: TransitionInput, inMaintenance: boolean, extra: RecordExtra = {}): TransitionOutput {
    const rt = this.runtime(m);
    const now = extra.ts ?? this.ctx.now();
    const ts = rt.lastBeatTs !== null && now <= rt.lastBeatTs ? rt.lastBeatTs + 1 : now;
    const prevStatus = rt.status;
    const prevBeat = rt.lastBeatTs !== null ? { ts: rt.lastBeatTs, status: rt.status } : null;
    const out = transition(
      { status: rt.status, retries: rt.retries, failedSinceNotify: rt.failedSinceNotify, outageOpen: rt.outage !== null, outageConfirmed: rt.outageConfirmed },
      { ...input, msg: cleanText(input.msg, MSG_MAX) } as TransitionInput,
      { maxRetries: m.maxRetries, resendEvery: m.resendEvery, upsideDown: m.upsideDown },
      inMaintenance,
    );
    const msg = cleanText(out.msg, MSG_MAX);
    const ops: WriteOp[] = [];
    const id = m.id;
    const uid = m.uid;

    // heartbeat
    ops.push((s) => s.heartbeat.run(uid, id, ts, out.status, out.latencyMs, msg || null));

    // aggregates (time-weighted, split across buckets)
    const cap = gapCapMs(m.intervalS, m.retryIntervalS, m.timeoutMs);
    const beat = { ts, status: out.status, latencyMs: out.latencyMs, counted: out.status !== 3 };
    const stats = {
      monitorId: id,
      uid,
      hour: beatContributions(prevBeat, beat, cap, HOUR_MS),
      day: beatContributions(prevBeat, beat, cap, DAY_MS),
    };

    // outages
    let downtimeMs: number | null = null;
    if (out.outage.close && rt.outage) {
      const holder = rt.outage;
      downtimeMs = ts - holder.startedAt;
      ops.push((s) => {
        if (holder.id !== null) s.outageClose.run(ts, holder.id);
      });
      rt.outage = null;
      rt.outageConfirmed = false;
    }
    if (out.outage.open) {
      const holder: OutageHolder = { id: null, startedAt: ts };
      const confirmed = out.outage.confirm;
      ops.push((s) => {
        const res = s.outageOpen.run(uid, id, ts, confirmed ? ts : null, msg || null);
        if (res.changes > 0) holder.id = Number(res.lastInsertRowid);
      });
      rt.outage = holder;
      rt.outageConfirmed = confirmed;
    } else if (out.outage.confirm && rt.outage) {
      const holder = rt.outage;
      ops.push((s) => {
        if (holder.id !== null) s.outageConfirm.run(ts, msg || null, holder.id);
      });
      rt.outageConfirmed = true;
    }

    // event (Kuma's important beat)
    if (out.important) {
      const from = prevStatus === -1 ? null : prevStatus;
      ops.push((s) => s.event.run(uid, id, ts, from, out.status, msg || null));
    }

    // notifications
    if (out.notify) {
      const payload = this.payload(m, out.notify, ts, out.status, prevStatus, msg, out.latencyMs, extra.target ?? null);
      if (out.notify === 'up') payload.downtimeMs = downtimeMs;
      ops.push(outboxOp(id, uid, out.notify, payload, ts));
    }

    // TLS certificate + expiry notices
    if (extra.tls) {
      const tls = extra.tls;
      ops.push((s) =>
        s.tls.run(
          uid,
          id,
          ts,
          tls.valid ? 1 : 0,
          tls.hostnameOk ? 1 : 0,
          tls.subject,
          tls.issuer,
          JSON.stringify(tls.sans.slice(0, 100)),
          tls.notBefore,
          tls.notAfter,
          tls.fingerprint256,
          JSON.stringify(tls.chain.slice(0, 10)),
        ),
      );
      if (m.certNotify && tls.notAfter !== null && tls.fingerprint256) {
        const daysLeft = Math.floor((tls.notAfter - ts) / DAY_MS);
        const crossed = expiryThresholdsCrossed(daysLeft);
        if (crossed.length > 0) {
          const payload = this.payload(m, 'cert', ts, out.status, prevStatus, `Certificate expires in ${daysLeft} day(s)`, null, extra.target ?? null);
          payload.cert = { daysLeft, notAfter: tls.notAfter, subject: tls.subject, host: extra.host ?? null };
          ops.push(noticeOp(id, uid, 'cert', tls.fingerprint256, crossed, payload, ts));
        }
      }
    }

    // domain expiry
    if (typeof extra.domainExpiresAt === 'number' && extra.host) {
      ops.push(...this.domainOps(m, extra.host, extra.domainExpiresAt, ts, out.status, prevStatus, extra.target ?? null));
    }

    // state
    const changed = out.status !== prevStatus;
    rt.status = out.status;
    rt.retries = out.retries;
    rt.failedSinceNotify = out.failedSinceNotify;
    rt.lastBeatTs = ts;
    if (changed) rt.lastChangeAt = ts;
    if (extra.push) rt.lastPushAt = ts;
    rt.lastLatencyMs = out.latencyMs;
    rt.lastMsg = msg || null;
    const snapshot = { ...rt, outage: rt.outage };
    ops.push((s) =>
      s.state.run(
        uid,
        id,
        snapshot.status,
        snapshot.retries,
        snapshot.failedSinceNotify,
        snapshot.lastBeatTs,
        snapshot.lastChangeAt,
        snapshot.lastPushAt,
        snapshot.lastLatencyMs,
        snapshot.lastMsg,
        snapshot.outage?.id ?? null,
      ),
    );

    this.writer.add(ops, stats);

    // live events (never let a listener break processing)
    try {
      this.bus.emit('beat', { uid: m.uid, siteId: m.siteId, ownerId: m.ownerId, ts, status: out.status, latencyMs: out.latencyMs, msg: msg || null });
      if (changed) this.bus.emit('state', { uid: m.uid, siteId: m.siteId, ownerId: m.ownerId, status: out.status, since: ts });
    } catch (err) {
      this.ctx.log.warn({ err: safeError(err) }, 'uptime: live event listener failed');
    }
    if (changed) {
      for (const fn of this.listeners) {
        try {
          fn(m, prevStatus, out.status);
        } catch {
          // ignore
        }
      }
    }
    return out;
  }

  /** Domain expiry learnt outside a check (RDAP lookups for monitors with domainNotify). */
  recordDomainExpiry(m: MonitorRecord, domain: string, expiresAt: number, target: string | null): void {
    const rt = this.runtime(m);
    this.writer.add(this.domainOps(m, domain, expiresAt, this.ctx.now(), rt.status, rt.status, target));
  }

  private domainOps(
    m: MonitorRecord,
    host: string,
    expiresAt: number,
    ts: number,
    status: number,
    prevStatus: number,
    target: string | null,
  ): WriteOp[] {
    const domain = host.toLowerCase();
    const ops: WriteOp[] = [(s) => s.domainExpiry.run(domain, expiresAt, ts)];
    if (m.domainNotify || m.type === 'domain') {
      const daysLeft = Math.floor((expiresAt - ts) / DAY_MS);
      const crossed = expiryThresholdsCrossed(daysLeft);
      if (crossed.length > 0) {
        const payload = this.payload(m, 'domain', ts, status, prevStatus, `Domain ${domain} expires in ${daysLeft} day(s)`, null, target);
        payload.domain = { daysLeft, expiresAt, domain };
        ops.push(noticeOp(m.id, m.uid, 'domain', `${domain}:${expiresAt}`, crossed, payload, ts));
      }
    }
    return ops;
  }

  /** NotifyPayload for this monitor (no secrets: name, type, display target, site). */
  payload(
    m: MonitorRecord,
    event: NotifyEvent,
    ts: number,
    status: number,
    prevStatus: number,
    msg: string | null,
    latencyMs: number | null,
    target: string | null,
  ): NotifyPayload {
    const base = this.ctx.config.publicUrl;
    return {
      event,
      ts,
      monitor: { uid: m.uid, name: m.name, type: m.type, target, siteId: m.siteId, siteName: m.siteName },
      status: statusName(status),
      previousStatus: prevStatus === -1 ? null : statusName(prevStatus),
      msg,
      latencyMs,
      dashboardUrl: base ? `${base}/monitors/${m.uid}` : null,
    };
  }

  /** maint_start / maint_end notifications for the channels of the given monitors. */
  maintenanceNotice(event: 'maint_start' | 'maint_end', maintenance: { uid: string; title: string }, monitorIds: readonly number[]): void {
    if (monitorIds.length === 0) return;
    const ts = this.ctx.now();
    const base = this.ctx.config.publicUrl;
    const payload: NotifyPayload = {
      event,
      ts,
      monitor: null,
      status: event === 'maint_start' ? 'maintenance' : null,
      previousStatus: null,
      msg: event === 'maint_start' ? `Maintenance started: ${maintenance.title}` : `Maintenance ended: ${maintenance.title}`,
      maintenance: { uid: maintenance.uid, title: maintenance.title },
      dashboardUrl: base ? `${base}/maintenance` : null,
    };
    const json = JSON.stringify(payload);
    const ids = [...monitorIds];
    this.writer.add([
      (s) => {
        const channels = new Set<number>();
        for (const mid of ids) for (const r of s.channels.all(mid) as Array<{ id: number }>) channels.add(r.id);
        for (const c of channels) s.outbox.run(c, null, event, json, ts, ts);
      },
    ]);
  }

  flush(): void {
    this.writer.flush();
  }

  close(): void {
    this.writer.close();
  }
}

function outboxOp(monitorId: number, uid: string, event: NotifyEvent, payload: NotifyPayload, ts: number): WriteOp {
  const json = JSON.stringify(payload);
  return (s: Statements) => {
    for (const r of s.monitorChannels.all(monitorId, uid) as Array<{ id: number }>) s.outbox.run(r.id, monitorId, event, json, ts, ts);
  };
}

/** Send once per (monitor, kind, fingerprint, smallest crossed threshold); record every crossed threshold. */
function noticeOp(monitorId: number, uid: string, kind: 'cert' | 'domain', fingerprint: string, crossed: number[], payload: NotifyPayload, ts: number): WriteOp {
  const smallest = Math.min(...crossed);
  const fp = fingerprint.slice(0, 200);
  return (s: Statements) => {
    if (s.noticeExists.get(monitorId, kind, fp, smallest)) return;
    for (const t of crossed) s.noticeInsert.run(monitorId, kind, fp, t, ts);
    outboxOp(monitorId, uid, kind, payload, ts)(s);
  };
}

function fromRecord(r: StateRecord | null, ctx: AppContext): MonitorRuntime {
  if (!r) {
    return {
      status: -1,
      retries: 0,
      failedSinceNotify: 0,
      lastBeatTs: null,
      lastChangeAt: null,
      lastPushAt: null,
      lastLatencyMs: null,
      lastMsg: null,
      outage: null,
      outageConfirmed: false,
    };
  }
  let outage: OutageHolder | null = null;
  let confirmed = false;
  if (r.openOutageId !== null) {
    const o = ctx.db.prepare('SELECT started_at, confirmed_at, ended_at FROM outages WHERE id = ?').get(r.openOutageId) as
      | { started_at: number; confirmed_at: number | null; ended_at: number | null }
      | undefined;
    if (o && o.ended_at === null) {
      outage = { id: r.openOutageId, startedAt: o.started_at };
      confirmed = o.confirmed_at !== null;
    }
  }
  const status = ([-1, 0, 1, 2, 3] as const).find((s) => s === r.status) ?? -1;
  return {
    status,
    retries: r.retries,
    failedSinceNotify: r.failedSinceNotify,
    lastBeatTs: r.lastCheckAt,
    lastChangeAt: r.lastChangeAt,
    lastPushAt: r.lastPushAt,
    lastLatencyMs: r.lastLatencyMs,
    lastMsg: r.lastMsg,
    outage,
    outageConfirmed: confirmed,
  };
}

/** Log-safe error: message + code only (never request options that may carry credentials). */
export function safeError(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? { message: cleanText(err.message, 300), code } : { message: cleanText(err.message, 300) };
  }
  return { message: 'unknown error' };
}

/** The processor of a context (created on first use; shared by the engine and the API). */
export function processorFor(ctx: AppContext, opts?: ProcessorOptions): ResultProcessor {
  const rt = uptimeRuntime(ctx);
  if (!(rt.processor instanceof ResultProcessor)) rt.processor = new ResultProcessor(ctx, opts);
  return rt.processor as ResultProcessor;
}

/** Flush and drop the processor (app close / engine stop). */
export function closeProcessor(ctx: AppContext): void {
  const rt = uptimeRuntime(ctx);
  if (rt.processor instanceof ResultProcessor) {
    rt.processor.close();
    rt.processor = null;
  }
}
