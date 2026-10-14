import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';
import { Notifier, RETRY_DELAYS_MS, startNotifier } from '../src/uptime/notify/dispatcher.js';
import { setNotifyOverrides } from '../src/uptime/notify/state.js';
import type { NotifyPayload } from '../src/uptime/types.js';
import { CLOUD_URL, api, createCloudApp, createTestApp, login, signupMember } from './helpers.js';
import { FakeNet, TEST_SECRETS_KEY, downPayload, upPayload } from './uptime-notify-fakes.js';

const apps: FastifyInstance[] = [];
const notifiers: Notifier[] = [];
afterEach(async () => {
  while (notifiers.length) await notifiers.pop()?.stop();
  while (apps.length) await apps.pop()?.close();
});

interface Env {
  ctx: AppContext;
  clock: { t: number };
  net: FakeNet;
  notifier: Notifier;
  cookie: string;
  app: FastifyInstance;
}

async function selfHosted(timeoutMs = 2000): Promise<Env> {
  const t = await createTestApp({ env: { SECRETS_KEY: TEST_SECRETS_KEY, PUBLIC_URL: CLOUD_URL } });
  apps.push(t.app);
  const net = new FakeNet();
  setNotifyOverrides(t.ctx, { net: () => net });
  const notifier = startNotifier(t.ctx, { autoStart: false, timeoutMs });
  notifiers.push(notifier);
  return { ctx: t.ctx, clock: t.clock, net, notifier, cookie: await login(t.app), app: t.app };
}

async function createChannel(e: Env, body: Record<string, unknown>, cookie = e.cookie): Promise<{ id: number; uid: string }> {
  const res = await api(e.app, cookie, 'POST', '/api/notification-channels', body);
  if (res.statusCode !== 201) throw new Error(res.body);
  const uid = (res.json() as { channel: { uid: string } }).channel.uid;
  return { uid, id: (e.ctx.db.prepare('SELECT id FROM notify_channels WHERE uid = ?').get(uid) as { id: number }).id };
}

const hook = (n = 1) => ({ type: 'webhook', name: `Hook ${n}`, config: { url: `https://hooks.example.com/${n}` } });

function enqueue(ctx: AppContext, channelId: number, payload: NotifyPayload = downPayload(), at = ctx.now()): number {
  return Number(
    ctx.db
      .prepare('INSERT INTO notify_outbox (channel_id, monitor_id, event, payload, next_attempt_at, created_at) VALUES (?, NULL, ?, ?, ?, ?)')
      .run(channelId, payload.event, JSON.stringify(payload), at, ctx.now()).lastInsertRowid,
  );
}

const outbox = (ctx: AppContext) => ctx.db.prepare('SELECT * FROM notify_outbox ORDER BY id').all() as Array<{ id: number; attempts: number; next_attempt_at: number }>;
const logRows = (ctx: AppContext) =>
  ctx.db.prepare('SELECT ok, http_status, error, event FROM notify_log ORDER BY id').all() as Array<{ ok: number; http_status: number | null; error: string | null; event: string }>;
const channel = (ctx: AppContext, id: number) => ctx.db.prepare('SELECT active, consecutive_failures FROM notify_channels WHERE id = ?').get(id) as { active: number; consecutive_failures: number };

describe('dispatcher', () => {
  it('delivers due rows, logs and removes them', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    enqueue(e.ctx, ch.id);
    enqueue(e.ctx, ch.id, upPayload(), e.ctx.now() + 60_000); // not due yet
    expect(await e.notifier.runOnce()).toBe(1);
    expect(e.net.requests).toHaveLength(1);
    expect(e.net.json().event).toBe('down');
    expect(outbox(e.ctx)).toHaveLength(1);
    expect(logRows(e.ctx)).toEqual([{ ok: 1, http_status: 200, error: null, event: 'down' }]);
    e.clock.t += 60_000;
    await e.notifier.runOnce();
    expect(e.net.json().event).toBe('up');
    expect(outbox(e.ctx)).toHaveLength(0);
  });

  it('retries transient failures at 30 s / 2 min / 10 min, then gives up and counts the failure', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    e.net.handler = () => ({ status: 503, body: 'unavailable' });
    enqueue(e.ctx, ch.id);
    const start = e.ctx.now();
    await e.notifier.runOnce();
    let row = outbox(e.ctx)[0];
    expect(row).toMatchObject({ attempts: 1, next_attempt_at: start + 30_000 });
    // Not due yet: nothing happens.
    e.clock.t += 29_000;
    await e.notifier.runOnce();
    expect(e.net.requests).toHaveLength(1);
    let total = 0;
    for (const [i, d] of RETRY_DELAYS_MS.entries()) {
      e.clock.t = start + total + d;
      total += d;
      await e.notifier.runOnce();
      expect(e.net.requests).toHaveLength(i + 2);
      row = outbox(e.ctx)[0];
      if (i < RETRY_DELAYS_MS.length - 1) expect(row).toMatchObject({ attempts: i + 2, next_attempt_at: e.clock.t + (RETRY_DELAYS_MS[i + 1] as number) });
    }
    expect(outbox(e.ctx)).toHaveLength(0);
    const logs = logRows(e.ctx);
    expect(logs).toHaveLength(4);
    expect(logs[0]?.error).toMatch(/HTTP 503: unavailable \(retry 1\/3 in 30s\)/);
    expect(logs[3]).toMatchObject({ ok: 0, http_status: 503, error: 'HTTP 503: unavailable' });
    expect(channel(e.ctx, ch.id)).toEqual({ active: 1, consecutive_failures: 1 });

    // A success resets the counter.
    e.net.handler = () => ({ status: 204 });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(channel(e.ctx, ch.id)).toEqual({ active: 1, consecutive_failures: 0 });
  });

  it('honours Retry-After, retries 408/429, never other 4xx', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    e.net.handler = () => ({ status: 429, headers: { 'retry-after': '300' } });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(outbox(e.ctx)[0]?.next_attempt_at).toBe(e.ctx.now() + 300_000);
    e.ctx.db.prepare('DELETE FROM notify_outbox').run();

    e.net.handler = () => ({ status: 408 });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(outbox(e.ctx)[0]?.attempts).toBe(1);
    e.ctx.db.prepare('DELETE FROM notify_outbox').run();

    e.net.handler = () => ({ status: 401, body: '{"message":"invalid token"}' });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(outbox(e.ctx)).toHaveLength(0);
    expect(logRows(e.ctx).at(-1)).toMatchObject({ ok: 0, http_status: 401, error: 'HTTP 401: invalid token' });

    // Destinations refused by SafeNet are not retried either.
    e.net.handler = () => Object.assign(new Error('10.0.0.1 is not allowed'), { name: 'TargetDeniedError' });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(outbox(e.ctx)).toHaveLength(0);
    expect(logRows(e.ctx).at(-1)?.error).toBe('destination not allowed');
  });

  it('times out hanging requests and retries them', async () => {
    const e = await selfHosted(50);
    const ch = await createChannel(e, hook());
    e.net.handler = () => new Promise(() => {});
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(outbox(e.ctx)[0]?.attempts).toBe(1);
    expect(logRows(e.ctx)[0]?.error).toMatch(/^timed out/);
  });

  it('auto-disables a channel after 10 consecutive failures and skips inactive channels', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    e.ctx.db.prepare('UPDATE notify_channels SET consecutive_failures = 9 WHERE id = ?').run(ch.id);
    e.net.handler = () => ({ status: 400 });
    enqueue(e.ctx, ch.id);
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    expect(channel(e.ctx, ch.id)).toEqual({ active: 0, consecutive_failures: 10 });
    expect(e.net.requests).toHaveLength(1); // the second row was dropped: channel inactive
    expect(outbox(e.ctx)).toHaveLength(0);
    const json = (await api(e.app, e.cookie, 'GET', `/api/notification-channels/${ch.uid}`)).json() as { channel: Record<string, unknown> };
    expect(json.channel).toMatchObject({ active: false, autoDisabled: true, consecutiveFailures: 10 });
    // Re-activating resets the counter.
    await api(e.app, e.cookie, 'PATCH', `/api/notification-channels/${ch.uid}`, { active: true });
    expect(channel(e.ctx, ch.id)).toEqual({ active: 1, consecutive_failures: 0 });
  });

  it('keeps per-channel order and runs at most 8 deliveries at once, 1 per channel', async () => {
    const e = await selfHosted();
    const chans: Array<{ id: number; uid: string }> = [];
    for (let i = 0; i < 10; i++) chans.push(await createChannel(e, hook(i)));
    let inflight = 0;
    let peak = 0;
    const perUrl = new Map<string, number>();
    e.net.handler = async (req) => {
      inflight++;
      peak = Math.max(peak, inflight);
      perUrl.set(req.url, (perUrl.get(req.url) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { status: 200 };
    };
    for (const c of chans) {
      enqueue(e.ctx, c.id, downPayload());
      enqueue(e.ctx, c.id, upPayload());
    }
    await e.notifier.runOnce();
    expect(peak).toBe(8);
    expect(e.net.requests).toHaveLength(20);
    for (const c of chans) {
      const events = e.net.requests.filter((r) => r.url.endsWith(`/${chans.indexOf(c)}`)).map((r) => (JSON.parse(r.bodyText) as { event: string }).event);
      expect(events).toEqual(['down', 'up']);
    }

    // A failing DOWN blocks the later UP of the same channel (no reordering).
    e.net.handler = (req) => ((JSON.parse(req.bodyText) as { event: string }).event === 'down' ? { status: 500 } : { status: 200 });
    const first = chans[0] as { id: number };
    enqueue(e.ctx, first.id, downPayload());
    enqueue(e.ctx, first.id, upPayload());
    const before = e.net.requests.length;
    await e.notifier.runOnce();
    expect(e.net.requests.length).toBe(before + 1);
    expect(outbox(e.ctx)).toHaveLength(2);
  });

  it('redacts secrets in the delivery log', async () => {
    const e = await selfHosted();
    const token = '123456789:AAH-abcdefghijklmnopqrstuvwxyz012345';
    const ch = await createChannel(e, { type: 'telegram', name: 'TG', config: { botToken: token, chatId: '1' } });
    e.net.handler = (req) => ({ status: 400, body: JSON.stringify({ description: `Bad Request: chat not found (${req.url})` }) });
    enqueue(e.ctx, ch.id);
    await e.notifier.runOnce();
    const err = logRows(e.ctx)[0]?.error ?? '';
    expect(err).toContain('chat not found');
    expect(err).not.toContain('AAH-abcdefghijklmnopqrstuvwxyz012345');
    expect(err.length).toBeLessThanOrEqual(300);
  });

  it('drops rows of deleted channels and cleans up in housekeeping', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    enqueue(e.ctx, ch.id);
    e.ctx.db.prepare("INSERT INTO notify_log (channel_id, ts, event, ok) VALUES (?, ?, 'down', 1)").run(ch.id, e.ctx.now() - 31 * 86_400_000);
    e.ctx.db.prepare("INSERT INTO notify_log (channel_id, ts, event, ok) VALUES (?, ?, 'down', 1)").run(ch.id, e.ctx.now());
    e.ctx.db.prepare('INSERT INTO notify_outbox (channel_id, event, payload, next_attempt_at, created_at) VALUES (999, ?, ?, 0, 0)').run('down', '{}');
    await e.notifier.housekeeping();
    expect((e.ctx.db.prepare('SELECT count(*) AS n FROM notify_log').get() as { n: number }).n).toBe(1);
    expect(outbox(e.ctx)).toHaveLength(1);
    await api(e.app, e.cookie, 'DELETE', `/api/notification-channels/${ch.uid}`);
    expect(outbox(e.ctx)).toHaveLength(0);
    await e.notifier.housekeeping();
    expect(e.ctx.db.prepare('SELECT count(*) AS n FROM notify_channels').get()).toEqual({ n: 0 });
  });

  it('stops gracefully', async () => {
    const e = await selfHosted();
    const ch = await createChannel(e, hook());
    e.net.handler = () => new Promise(() => {});
    enqueue(e.ctx, ch.id);
    const n = startNotifier(e.ctx, { pollMs: 10, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(e.net.requests).toHaveLength(1);
    const t0 = Date.now();
    await n.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    // Aborted by shutdown: the row stays for the next start.
    expect(outbox(e.ctx)).toHaveLength(1);
  });
});

describe('member delivery cap (hosted)', () => {
  it('drops and logs deliveries beyond MEMBER_NOTIFY_PER_HOUR', async () => {
    const t = await createCloudApp({ env: { SECRETS_KEY: TEST_SECRETS_KEY, MEMBER_NOTIFY_PER_HOUR: '2' } });
    apps.push(t.app);
    const net = new FakeNet();
    setNotifyOverrides(t.ctx, { net: () => net });
    const m = await signupMember(t, 'm@example.com');
    const notifier = startNotifier(t.ctx, { autoStart: false });
    notifiers.push(notifier);
    const e: Env = { ctx: t.ctx, clock: t.clock, net, notifier, cookie: m.cookie, app: t.app };
    const ch = await createChannel(e, hook());
    for (let i = 0; i < 3; i++) enqueue(t.ctx, ch.id);
    await notifier.runOnce();
    expect(net.requests).toHaveLength(2);
    expect(logRows(t.ctx).at(-1)).toMatchObject({ ok: 0, error: expect.stringMatching(/hourly delivery limit/) });
    // A retry of an already counted delivery is not counted again; a new hour allows more.
    t.clock.t += 3_600_001;
    enqueue(t.ctx, ch.id);
    await notifier.runOnce();
    expect(net.requests).toHaveLength(3);
  });
});
