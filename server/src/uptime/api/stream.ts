// Live updates over Server-Sent Events: GET /api/uptime/stream (docs/SPEC.md §8.3).
// The reply is hijacked, so Fastify's onSend hook (security headers) does not run: the headers
// are applied explicitly before writing the head. Only monitors of sites the user can access are
// streamed; the session is re-validated on every keep-alive and the stream ends when it is gone.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { requireAuth } from '../../auth/guard.js';
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

function canSee(user: User, ownerId: number | null): boolean {
  if (user.role === 'admin' || user.role === 'viewer') return true;
  return user.role === 'member' && ownerId === user.id;
}

export async function streamRoutes(app: FastifyInstance, opts: { ctx: AppContext } & StreamOptions): Promise<void> {
  const { ctx } = opts;
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const perUser = new Map<number, number>();
  const open = new Set<() => void>();
  const guard = requireAuth(ctx);

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
    const onBeat = (e: BeatEvent): void => {
      if (!canSee(user, e.ownerId)) return;
      send(`event: beat\ndata: ${JSON.stringify({ uid: e.uid, ts: e.ts, status: e.status, latencyMs: e.latencyMs, msg: e.msg })}\n\n`);
    };
    const onState = (e: StateEvent): void => {
      if (!canSee(user, e.ownerId)) return;
      send(`event: state\ndata: ${JSON.stringify({ uid: e.uid, status: e.status, since: e.since })}\n\n`);
    };
    const timer = setInterval(() => {
      // Re-validate the session (logout, password change, deleted account end the stream).
      guard.call(app, request, reply)
        .then(() => {
          if (request.user?.id !== user.id) close();
          else send(': keep-alive\n\n');
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
