// Test doubles for the notification module: a recording SafeNet and payload builders.
import type { AppContext } from '../src/context.js';
import type { HttpRequestOptions, HttpResponse, NotifyPayload, SafeNet } from '../src/uptime/types.js';

export interface RecordedRequest extends HttpRequestOptions {
  bodyText: string;
}

export type FakeReply = Partial<Omit<HttpResponse, 'body'>> & { body?: string | Buffer };

/** SafeNet that records every request and answers from `handler` (default: 200 {"ok":true}). */
export class FakeNet implements SafeNet {
  requests: RecordedRequest[] = [];
  handler: (req: RecordedRequest) => FakeReply | Error | Promise<FakeReply | Error> = () => ({ status: 200, body: '{"ok":true}' });

  async request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const rec: RecordedRequest = { ...opts, bodyText: opts.body === undefined ? '' : Buffer.isBuffer(opts.body) ? opts.body.toString('utf8') : opts.body };
    this.requests.push(rec);
    const r = await this.handler(rec);
    if (r instanceof Error) throw r;
    const body = r.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      truncated: false,
      url: opts.url,
      redirects: 0,
      timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, totalMs: 0 },
      remoteAddress: '203.0.113.10',
      ...r,
      body,
    };
  }

  async resolve(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async connect(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async dnsQuery(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  async udp(): Promise<never> {
    throw new Error('not implemented in FakeNet');
  }
  assertAllowed(): void {}

  get last(): RecordedRequest {
    const r = this.requests[this.requests.length - 1];
    if (!r) throw new Error('no request recorded');
    return r;
  }

  json(i = this.requests.length - 1): Record<string, unknown> {
    const r = this.requests[i];
    if (!r) throw new Error('no request recorded');
    return JSON.parse(r.bodyText) as Record<string, unknown>;
  }
}

export const HOSTILE_NAME = '<b>@everyone</b>';
export const HOSTILE_MSG = '<!channel> <@U123> *bold* _x_ @here [link](http://evil.example) ‮gnp.exe\n<script>';

export function downPayload(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    event: 'down',
    ts: Date.UTC(2026, 5, 15, 12, 0, 0),
    monitor: { uid: 'mon000000001', name: HOSTILE_NAME, type: 'http', target: 'https://example.com/', siteId: 'site00000001', siteName: 'Example' },
    status: 'down',
    previousStatus: 'up',
    msg: HOSTILE_MSG,
    latencyMs: null,
    dashboardUrl: 'https://analytics.example.com/sites/site00000001/uptime',
    ...over,
  };
}

export function upPayload(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return downPayload({ event: 'up', status: 'up', previousStatus: 'down', msg: '200 OK', latencyMs: 123, downtimeMs: 125_000, ...over });
}

export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');

/* ------------------------------------------------------------- outbox rows */

const ownedMonitors = new WeakMap<AppContext, Map<string, { id: number; uid: string; siteId: string }>>();
let ownedSeq = 0;

/** A live monitor on a site of `ownerId` (null = operator site), created once per app and owner. */
export function ownedMonitor(ctx: AppContext, ownerId: number | null): { id: number; uid: string; siteId: string } {
  let byOwner = ownedMonitors.get(ctx);
  if (!byOwner) ownedMonitors.set(ctx, (byOwner = new Map()));
  const key = String(ownerId);
  const hit = byOwner.get(key);
  if (hit) return hit;
  const n = ++ownedSeq;
  const site = ctx.sites.create(`Site ${n}`, [`s${n}.example.com`], ctx.now(), ownerId);
  const uid = `own${String(n).padStart(9, '0')}`;
  const r = ctx.db
    .prepare(
      `INSERT INTO monitors (uid, site_id, type, name, interval_s, retry_interval_s, timeout_ms, config, created_at, updated_at)
       VALUES (?, ?, 'http', ?, 60, 60, 10000, '{}', ?, ?)`,
    )
    .run(uid, site.id, `Monitor ${uid}`, ctx.now(), ctx.now());
  const m = { id: Number(r.lastInsertRowid), uid, siteId: site.id };
  byOwner.set(key, m);
  return m;
}

/**
 * Queue an outbox row the way the engine does: a monitor event references a monitor of the
 * channel's owner and the payload names that monitor.
 */
export function enqueueOwned(ctx: AppContext, channelId: number, payload: NotifyPayload = downPayload(), at = ctx.now()): number {
  const ch = ctx.db.prepare('SELECT owner_id FROM notify_channels WHERE id = ?').get(channelId) as { owner_id: number | null };
  const m = ownedMonitor(ctx, ch.owner_id);
  const p: NotifyPayload = payload.monitor ? { ...payload, monitor: { ...payload.monitor, uid: m.uid, siteId: m.siteId } } : payload;
  return Number(
    ctx.db
      .prepare('INSERT INTO notify_outbox (channel_id, monitor_id, event, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channelId, payload.monitor ? m.id : null, payload.event, JSON.stringify(p), at, ctx.now()).lastInsertRowid,
  );
}
