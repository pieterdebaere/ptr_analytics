// Live updates over Server-Sent Events: GET /api/uptime/stream (docs/SPEC.md §8.3).
// The reply is hijacked, so Fastify's onSend hook (security headers) does not run: the headers
// are applied explicitly before writing the head.
//
// Access is decided per event with the *current* state, never with what was true at connect time
// (audit MEDIUM 3: a demoted admin kept receiving every tenant's events): the account is re-read
// (cached ≤ 1 s) and must still exist with the same role, and the event's site is re-read (cached
// ≤ 1 s) and checked with canAccessSite(). The stream is closed as soon as the account is gone or
// its role changed; the session itself is re-validated on every keep-alive.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { canAccessSite } from '../../auth/access.js';
import { requireAuth } from '../../auth/guard.js';
import type { Site } from '../../data/sites.js';
import type { User } from '../../data/users.js';
import { tooMany } from '../../lib/errors.js';
import { applySecurityHeaders } from '../../security.js';
import { uptimeRuntime, type BeatEvent, type StateEvent } from '../runtime.js';
import { requireUser } from './shared.js';

export const SSE_KEEPALIVE_MS = 25_000;
export const SSE_MAX_PER_USER = 5;
const SSE_MAX_TOTAL = 2000;
/** A client that does not read is disconnected once this much is buffered. */
const MAX_BUFFERED = 512 * 1024;

export interface StreamOptions {
  keepAliveMs?: number;
}

/** Fresh lookups shared by all streams of an app: at most one query per key and TTL. */
const LOOKUP_TTL_MS = 1000;

class FreshCache<K, V> {
  private readonly map = new Map<K, { at: number; v: V }>();
  constructor(
    private readonly load: (k: K) => V,
    private readonly now: () => number,
  ) {}
  get(k: K): V {
    const t = this.now();
    const hit = this.map.get(k);
    if (hit && t >= hit.at && t - hit.at < LOOKUP_TTL_MS) return hit.v;
    const v = this.load(k);
    if (this.map.size > 10_000) this.map.clear();
    this.map.set(k, { at: t, v });
    return v;
  }
  clear(): void {
    this.map.clear();
  }
}

export async function streamRoutes(app: FastifyInstance, opts: { ctx: AppContext } & StreamOptions): Promise<void> {
  const { ctx } = opts;
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const perUser = new Map<number, number>();
  const open = new Set<() => void>();
  const guard = requireAuth(ctx);
  // Real time (not ctx.now, which tests freeze): bounds the staleness of role / ownership checks.
  const users = new FreshCache<number, User | null>((id) => ctx.users.byId(id), Date.now);
  const sites = new FreshCache<string, Site | null>((id) => ctx.sites.byId(id), Date.now);
  // Deletions and suspension changes are visible to the next event at once.
  const unsubs = [ctx.sites.onChange(() => sites.clear()), ctx.users.onChange(() => users.clear())];
  app.addHook('onClose', async () => {
    for (const u of unsubs) u();
  });

  app.addHook('preClose', async () => {
    for (const close of [...open]) close();
  });

  app.get('/api/uptime/stream', async (request, reply) => {
    const user = requireUser(request);
    const count = perUser.get(user.id) ?? 0;
    if (count >= SSE_MAX_PER_USER || open.size >= SSE_MAX_TOTAL) {
      reply.header('Retry-After', '30');
      throw tooMany('too many live connections');
    }
    applySecurityHeaders(request, reply, ctx.config);
    reply.hijack();
    const raw: ServerResponse = reply.raw;
    const headers: Record<string, string | number | string[]> = {};
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) headers[k] = v as string | number | string[];
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    // Keep-alives every 25 s; the socket idle timeout must be longer than that.
    request.raw.socket?.setTimeout(Math.max(keepAliveMs * 3, 60_000));
    perUser.set(user.id, count + 1);

    const bus = uptimeRuntime(ctx).bus;
    let closed = false;
    const send = (chunk: string): void => {
      if (closed) return;
      if (raw.writableLength > MAX_BUFFERED) {
        close();
        return;
      }
      try {
        raw.write(chunk);
      } catch {
        close();
      }
    };
    /** The account as it is now: same id and role as at connect time, or the stream ends. */
    const current = (): User | null => {
      const fresh = users.get(user.id);
      if (!fresh || fresh.role !== user.role) {
        close();
        return null;
      }
      return fresh;
    };
    const canSee = (e: { siteId: string }): boolean => {
      if (closed) return false;
      const u = current();
      if (!u) return false;
      const site = sites.get(e.siteId);
      return site !== null && canAccessSite(u, site, 'read');
    };
    const onBeat = (e: BeatEvent): void => {
      if (!canSee(e)) return;
      send(`event: beat\ndata: ${JSON.stringify({ uid: e.uid, ts: e.ts, status: e.status, latencyMs: e.latencyMs, msg: e.msg })}\n\n`);
    };
    const onState = (e: StateEvent): void => {
      if (!canSee(e)) return;
      send(`event: state\ndata: ${JSON.stringify({ uid: e.uid, status: e.status, since: e.since })}\n\n`);
    };
    const timer = setInterval(() => {
      // Re-validate the session (logout, password change, deleted account end the stream).
      guard.call(app, request, reply)
        .then(() => {
          const now = request.user;
          if (!now || now.id !== user.id || now.role !== user.role) close();
          else if (current()) send(': keep-alive\n\n');
        })
        .catch(() => close());
    }, keepAliveMs);
    timer.unref();

    function close(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      bus.off('beat', onBeat);
      bus.off('state', onState);
      open.delete(close);
      const n = (perUser.get(user.id) ?? 1) - 1;
      if (n <= 0) perUser.delete(user.id);
      else perUser.set(user.id, n);
      try {
        raw.end();
      } catch {
        // already gone
      }
    }

    open.add(close);
    bus.on('beat', onBeat);
    bus.on('state', onState);
    raw.on('close', close);
    raw.on('error', close);
    send('retry: 5000\n: connected\n\n');
  });
}
