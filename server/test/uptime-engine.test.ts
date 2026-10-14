import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { createEngine, destinationOf, scrubSecrets, type Engine, type EngineOptions } from '../src/uptime/engine/index.js';
import { processorFor } from '../src/uptime/engine/processor.js';
import { phaseOf } from '../src/uptime/engine/scheduler.js';
import { setCheckers } from '../src/uptime/runtime.js';
import type { SecretBox } from '../src/uptime/secrets.js';
import type { NotifyPayload } from '../src/uptime/types.js';
import { MIN, api, createTestApp, login, type TestApp } from './helpers.js';
import { FakeClock, FakeResults, fakeCheckers, fakeSecretBox, nullNet, settle } from './uptime-core-fakes.js';

let t: TestApp;
let ctx: AppContext;
let admin: string;
let siteId: string;
let results: FakeResults;
let clock: FakeClock;
let engine: Engine | null;

const SEC = 1000;

beforeEach(async () => {
  t = await createTestApp({ now: Date.UTC(2026, 5, 15, 12, 0, 0) });
  ctx = t.ctx;
  ctx.secretBox = () => fakeSecretBox as SecretBox;
  results = new FakeResults();
  setCheckers(ctx, fakeCheckers(results));
  admin = await login(t.app);
  const res = await api(t.app, admin, 'POST', '/api/sites', { name: 'Site', domains: ['example.com'] });
  siteId = (res.json() as { site: { id: string } }).site.id;
  clock = new FakeClock(t.clock);
  engine = null;
});

afterEach(async () => {
  await engine?.stop();
  await t.app.close();
});

function start(opts: EngineOptions = {}): Engine {
  engine = createEngine(ctx, { clock, netFactory: () => nullNet, startupSpreadMs: 1000, ...opts });
  return engine;
}

async function createMonitor(body: Record<string, unknown>): Promise<{ uid: string; id: number; pushUrl: string | null }> {
  const res = await api(t.app, admin, 'POST', `/api/sites/${siteId}/monitors`, {
    type: 'fakehttp',
    name: 'Mon',
    intervalS: 60,
    config: { url: 'https://example.com/' },
    ...body,
  });
  if (res.statusCode !== 201) throw new Error(`create monitor: ${res.statusCode} ${res.body}`);
  const m = (res.json() as { monitor: { uid: string; pushUrl: string | null } }).monitor;
  const id = (ctx.db.prepare('SELECT id FROM monitors WHERE uid = ?').get(m.uid) as { id: number }).id;
  return { uid: m.uid, id, pushUrl: m.pushUrl };
}

function addChannel(ownerId: number | null = null): number {
  const res = ctx.db
    .prepare(
      `INSERT INTO notify_channels (uid, owner_id, type, name, config, is_default, active, created_at, updated_at)
       VALUES (?, ?, 'webhook', 'Hook', '{}', 0, 1, ?, ?)`,
    )
    .run(`ch${Math.random().toString(36).slice(2, 12)}`.slice(0, 12).padEnd(12, '0'), ownerId, ctx.now(), ctx.now());
  return Number(res.lastInsertRowid);
}

function link(monitorId: number, channelId: number): void {
  ctx.db.prepare('INSERT INTO monitor_channels (monitor_id, channel_id) VALUES (?, ?)').run(monitorId, channelId);
}

const flush = (): void => processorFor(ctx).flush();
/** Advance the clock to the next scheduled run of a monitor (and run it). */
async function runNext(id: number): Promise<number> {
  const wait = (engine!.dueOf(id) as number) - engine!.engineNow();
  await clock.advance(Math.max(0, wait));
  return wait;
}
const beats = (id: number): Array<{ ts: number; status: number; latency_ms: number | null; msg: string | null }> =>
  ctx.db.prepare('SELECT ts, status, latency_ms, msg FROM heartbeats WHERE monitor_id = ? ORDER BY ts').all(id) as never;
const outbox = (): Array<{ channel_id: number; monitor_id: number | null; event: string; payload: string }> =>
  ctx.db.prepare('SELECT channel_id, monitor_id, event, payload FROM notify_outbox ORDER BY id').all() as never;
const state = (id: number): { status: number; retries: number; failed_since_notify: number; open_outage_id: number | null; last_push_at: number | null } =>
  ctx.db.prepare('SELECT * FROM monitor_state WHERE monitor_id = ?').get(id) as never;

describe('engine: checks, scheduling and persistence', () => {
  it('runs a new monitor at once, then once per interval (phase aligned), and writes in batches', async () => {
    start();
    const m = await createMonitor({});
    await clock.advance(1);
    expect(results.calls.length).toBe(1);
    await clock.advance(5 * MIN);
    // the first run was immediate, then 5 phase-aligned runs (one per minute)
    expect(results.calls.length).toBe(6);
    const due = engine!.dueOf(m.id) as number;
    expect(due - engine!.engineNow()).toBeLessThanOrEqual(MIN);
    // nothing written before the flush timer (500 ms real time) — flush explicitly
    flush();
    const hb = beats(m.id);
    expect(hb).toHaveLength(6);
    expect(hb.every((b) => b.status === 1 && b.latency_ms === 25)).toBe(true);
    const st = state(m.id);
    expect(st.status).toBe(1);
    // time-weighted aggregates: the time between beats counts as up
    const up = ctx.db.prepare('SELECT SUM(up_ms) AS up, SUM(checks) AS checks, SUM(lat_n) AS n FROM monitor_stats_hour WHERE monitor_id = ?').get(m.id) as {
      up: number;
      checks: number;
      n: number;
    };
    expect(up.checks).toBe(6);
    expect(up.n).toBe(6);
    expect(up.up).toBe(hb[hb.length - 1]!.ts - hb[0]!.ts);
    const day = ctx.db.prepare('SELECT SUM(up_ms) AS up FROM monitor_stats_day WHERE monitor_id = ?').get(m.id) as { up: number };
    expect(day.up).toBe(up.up);
  });

  it('retries -> pending at the retry interval -> down with notification, event and outage; then recovery', async () => {
    start();
    const ch = addChannel(null);
    const m = await createMonitor({ maxRetries: 2, retryIntervalS: 20 });
    link(m.id, ch);
    await clock.advance(1);
    results.set(m.uid, { status: 'down', msg: 'connection refused' });
    await runNext(m.id); // next phase slot: PENDING (1)
    flush();
    expect(state(m.id)).toMatchObject({ status: 2, retries: 1 });
    expect(await runNext(m.id)).toBe(20 * SEC); // retry interval: PENDING (2)
    expect(await runNext(m.id)).toBe(20 * SEC); // DOWN
    flush();
    expect(state(m.id)).toMatchObject({ status: 0, retries: 3 });
    const hb = beats(m.id).map((b) => b.status);
    expect(hb).toEqual([1, 2, 2, 0]);
    let ob = outbox();
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ channel_id: ch, monitor_id: m.id, event: 'down' });
    const payload = JSON.parse(ob[0]!.payload) as NotifyPayload;
    expect(payload).toMatchObject({ event: 'down', status: 'down', previousStatus: 'pending', msg: 'connection refused' });
    expect(payload.monitor).toMatchObject({ uid: m.uid, name: 'Mon', type: 'fakehttp', target: 'https://example.com/', siteId, siteName: 'Site' });
    expect(payload.dashboardUrl).toBeNull(); // no PUBLIC_URL in tests
    const outage = ctx.db.prepare('SELECT * FROM outages WHERE monitor_id = ?').get(m.id) as { started_at: number; confirmed_at: number; ended_at: number | null };
    expect(outage.confirmed_at - outage.started_at).toBe(40 * SEC);
    expect(outage.ended_at).toBeNull();
    // DOWN checks run at the normal interval (phase slots), not the retry interval
    expect((((engine!.dueOf(m.id)! - phaseOf(m.uid, MIN)) % MIN) + MIN) % MIN).toBe(0);
    results.set(m.uid, { status: 'up', msg: '200 OK', latencyMs: 10 });
    await runNext(m.id);
    flush();
    ob = outbox();
    expect(ob.map((o) => o.event)).toEqual(['down', 'up']);
    const upPayload = JSON.parse(ob[1]!.payload) as NotifyPayload;
    expect(upPayload.downtimeMs).toBeGreaterThan(40 * SEC);
    const events = ctx.db.prepare('SELECT from_status, to_status FROM monitor_events WHERE monitor_id = ? ORDER BY id').all(m.id);
    expect(events).toEqual([
      { from_status: null, to_status: 1 },
      { from_status: 2, to_status: 0 },
      { from_status: 0, to_status: 1 },
    ]);
    const closed = ctx.db.prepare('SELECT ended_at FROM outages WHERE monitor_id = ?').get(m.id) as { ended_at: number | null };
    expect(closed.ended_at).not.toBeNull();
    expect(state(m.id).open_outage_id).toBeNull();
    const pend = ctx.db.prepare('SELECT SUM(pending_ms) AS p, SUM(down_ms) AS d FROM monitor_stats_hour WHERE monitor_id = ?').get(m.id) as { p: number; d: number };
    expect(pend.p).toBe(40 * SEC);
    expect(pend.d).toBeGreaterThan(0);
  });

  it('only active, non-deleted channels receive outbox rows; resend every N', async () => {
    start();
    const live = addChannel(null);
    const paused = addChannel(null);
    ctx.db.prepare('UPDATE notify_channels SET active = 0 WHERE id = ?').run(paused);
    const gone = addChannel(null);
    ctx.db.prepare('UPDATE notify_channels SET deleted_at = 1 WHERE id = ?').run(gone);
    const m = await createMonitor({ resendEvery: 2 });
    for (const c of [live, paused, gone]) link(m.id, c);
    results.set(m.uid, { status: 'down', msg: 'boom' });
    await clock.advance(1);
    await clock.advance(5 * MIN);
    flush();
    const ob = outbox();
    expect(new Set(ob.map((o) => o.channel_id))).toEqual(new Set([live]));
    // first beat DOWN notifies, then every 2 further down beats
    expect(ob.map((o) => o.event)).toEqual(['down', 'resend', 'resend']);
  });

  it('decrypts secrets for the checker and scrubs them from messages', async () => {
    start();
    const m = await createMonitor({ config: { url: 'https://example.com/', password: 'hunter2-secret' } });
    results.set(m.uid, (c) => ({ status: 'down', msg: `auth failed for ${c.secrets['password']}` }));
    await clock.advance(1);
    flush();
    expect(results.calls[0]?.secrets).toEqual({ password: 'hunter2-secret' });
    expect(beats(m.id)[0]?.msg).toBe('auth failed for ***');
    expect(scrubSecrets('a abc b', { x: 'abc' })).toBe('a abc b'); // too short to scrub
  });

  it('times out hanging checks (abort signal) and the watchdog frees the slot', async () => {
    start({ watchdogGraceMs: 5000 });
    const m = await createMonitor({ timeoutMs: 2000 });
    let aborted = false;
    results.set(m.uid, (c) => new Promise(() => c.signal.addEventListener('abort', () => (aborted = true))));
    await clock.advance(1);
    expect(engine!.stats().inFlight).toBe(1);
    await clock.advance(2000);
    expect(aborted).toBe(true);
    await clock.advance(5000);
    flush();
    expect(engine!.stats().inFlight).toBe(0);
    const b = beats(m.id);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ status: 0 });
    expect(b[0]?.msg).toMatch(/Timeout after 2s/);
  });

  it('a throwing checker is recorded as a failure, never crashes the engine', async () => {
    start();
    const m = await createMonitor({});
    results.set(m.uid, () => {
      throw new Error('kaput');
    });
    await clock.advance(1);
    flush();
    expect(beats(m.id)[0]).toMatchObject({ status: 0, msg: 'kaput' });
  });

  it('paused monitors and monitors of suspended or deleted sites are not scheduled', async () => {
    start();
    const m = await createMonitor({});
    await clock.advance(1);
    expect(results.calls.length).toBe(1);
    await api(t.app, admin, 'POST', `/api/monitors/${m.uid}/pause`);
    await clock.advance(3 * MIN);
    expect(results.calls.length).toBe(1);
    await api(t.app, admin, 'POST', `/api/monitors/${m.uid}/resume`);
    await clock.advance(1);
    expect(results.calls.length).toBe(2);
    ctx.db.prepare('UPDATE sites SET suspended = 1 WHERE id = ?').run(siteId);
    engine!.resync();
    await clock.advance(3 * MIN);
    expect(results.calls.length).toBe(2);
    ctx.db.prepare('UPDATE sites SET suspended = 0 WHERE id = ?').run(siteId);
    engine!.resync();
    await clock.advance(2 * MIN);
    expect(results.calls.length).toBeGreaterThan(2);
    const n = results.calls.length;
    await api(t.app, admin, 'DELETE', `/api/sites/${siteId}`);
    engine!.resync();
    await clock.advance(3 * MIN);
    expect(results.calls.length).toBe(n);
  });

  it('records TLS info and sends one certificate notice per threshold', async () => {
    start();
    const ch = addChannel(null);
    const m = await createMonitor({});
    link(m.id, ch);
    const notAfter = clock.wall() + 10 * 86_400_000 + 3_600_000;
    results.set(m.uid, {
      status: 'up',
      msg: 'OK',
      latencyMs: 5,
      tls: {
        valid: true,
        hostnameOk: true,
        subject: 'CN=example.com',
        issuer: 'CN=Test CA',
        sans: ['example.com'],
        notBefore: 0,
        notAfter,
        fingerprint256: 'AA:BB',
        chain: [],
      },
    });
    await clock.advance(1);
    await clock.advance(3 * MIN);
    flush();
    const cert = outbox().filter((o) => o.event === 'cert');
    expect(cert).toHaveLength(1);
    expect((JSON.parse(cert[0]!.payload) as NotifyPayload).cert).toMatchObject({ daysLeft: 10, notAfter, host: 'example.com' });
    const res = await api(t.app, admin, 'GET', `/api/monitors/${m.uid}`);
    expect((res.json() as { monitor: { tls: unknown } }).monitor.tls).toMatchObject({ notAfter, daysLeft: 10, issuer: 'CN=Test CA', valid: true });
  });
});

describe('engine: push monitors', () => {
  it('DOWN when no push arrives within the interval (after the grace period), UP on push', async () => {
    start();
    const ch = addChannel(null);
    const m = await createMonitor({ type: 'push', intervalS: 120, config: {} });
    link(m.id, ch);
    expect(m.pushUrl).toMatch(/^\/api\/push\/[A-Za-z0-9_-]{32}$/);
    await clock.advance(MIN);
    flush();
    expect(beats(m.id)).toHaveLength(0); // grace: one interval
    await clock.advance(MIN + 2 * SEC);
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([0]);
    expect(beats(m.id)[0]?.msg).toBe('No heartbeat in the time window');
    // push arrives
    const res = await t.app.inject({ method: 'GET', url: `${m.pushUrl}?status=up&msg=hello&ping=12.4` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([0, 1]);
    expect(beats(m.id)[1]).toMatchObject({ latency_ms: 12, msg: 'hello' });
    expect(state(m.id).last_push_at).toBe(clock.wall());
    // regular pushes keep it up; no extra beats from the engine
    for (let i = 0; i < 3; i++) {
      await clock.advance(100 * SEC);
      await t.app.inject({ method: 'POST', url: m.pushUrl!, headers: { 'content-type': 'text/plain' }, payload: 'x' });
    }
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([0, 1, 1, 1, 1]);
    // pushes stop: DOWN after interval + 1 s, then repeated failures every interval
    await clock.advance(121 * SEC);
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([0, 1, 1, 1, 1, 0]);
    expect(outbox().map((o) => o.event)).toEqual(['down', 'up', 'down']);
    await clock.advance(120 * SEC);
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([0, 1, 1, 1, 1, 0, 0]);
  });

  it('status=down pushes count as failures; upside-down flips them', async () => {
    start();
    const m = await createMonitor({ type: 'push', intervalS: 120, config: {}, upsideDown: true });
    await t.app.inject({ method: 'GET', url: `${m.pushUrl}?status=down` });
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([1]);
    await t.app.inject({ method: 'GET', url: `${m.pushUrl}` });
    flush();
    expect(beats(m.id).map((b) => b.status)).toEqual([1, 0]);
  });
});

describe('engine: groups and manual monitors', () => {
  it('a group derives its status from its children (event driven)', async () => {
    start({ groupDebounceMs: 1000 });
    const g = await createMonitor({ type: 'group', name: 'Group', config: {} });
    const a = await createMonitor({ name: 'A', parentUid: g.uid });
    const b = await createMonitor({ name: 'B', parentUid: g.uid });
    await clock.advance(2 * SEC);
    flush();
    expect(state(g.id).status).toBe(1);
    results.set(b.uid, { status: 'down', msg: 'no' });
    await clock.advance(MIN + 2 * SEC);
    flush();
    expect(state(b.id).status).toBe(0);
    expect(state(g.id).status).toBe(0);
    expect(beats(g.id).at(-1)?.msg).toBe('Child inaccessible');
    expect(state(a.id).status).toBe(1);
    results.set(b.uid, { status: 'up', msg: 'yes' });
    await clock.advance(MIN + 2 * SEC);
    flush();
    expect(state(g.id).status).toBe(1);
  });

  it('an empty group is pending', async () => {
    start();
    const g = await createMonitor({ type: 'group', config: {} });
    await clock.advance(2 * SEC);
    flush();
    expect(beats(g.id).at(-1)).toMatchObject({ status: 2, msg: 'Group empty' });
  });

  it('manual monitors take their status from the API', async () => {
    start();
    const m = await createMonitor({ type: 'manual', config: {} });
    await clock.advance(1);
    flush();
    expect(beats(m.id).at(-1)).toMatchObject({ status: 2, msg: 'No status set' });
    const res = await api(t.app, admin, 'POST', `/api/monitors/${m.uid}/status`, { status: 'down', msg: 'Provider outage' });
    expect(res.statusCode).toBe(200);
    await clock.advance(1);
    flush();
    expect(beats(m.id).at(-1)).toMatchObject({ status: 0, msg: 'Provider outage' });
    await clock.advance(5 * MIN);
    flush();
    expect(beats(m.id).at(-1)).toMatchObject({ status: 0, msg: 'Provider outage' });
  });
});

describe('engine: maintenance', () => {
  it('monitors (and group descendants) in a window record MAINTENANCE without running checks or notifying', async () => {
    start();
    const ch = addChannel(null);
    const g = await createMonitor({ type: 'group', config: {} });
    const child = await createMonitor({ name: 'child', parentUid: g.uid });
    link(child.id, ch);
    link(g.id, ch);
    await clock.advance(2 * SEC);
    const callsBefore = results.calls.length;
    results.set(child.uid, { status: 'down', msg: 'down during maintenance' });
    const res = await api(t.app, admin, 'POST', '/api/maintenances', { title: 'Upgrade', strategy: 'manual', monitorUids: [g.uid] });
    expect(res.statusCode).toBe(201);
    await clock.advance(3 * MIN);
    flush();
    expect(results.calls.length).toBe(callsBefore);
    expect(state(child.id).status).toBe(3);
    expect(state(g.id).status).toBe(3);
    const events = outbox().map((o) => o.event);
    expect(events).not.toContain('down');
    expect(events).toContain('maint_start');
    // end of maintenance: the child comes out DOWN -> notifies
    const uid = (res.json() as { maintenance: { uid: string } }).maintenance.uid;
    await api(t.app, admin, 'POST', `/api/maintenances/${uid}/pause`);
    await clock.advance(2 * MIN);
    flush();
    expect(state(child.id).status).toBe(0);
    expect(outbox().map((o) => o.event)).toEqual(expect.arrayContaining(['maint_start', 'maint_end', 'down']));
    const stats = ctx.db.prepare('SELECT SUM(maint_ms) AS m FROM monitor_stats_hour WHERE monitor_id = ?').get(child.id) as { m: number };
    expect(stats.m).toBeGreaterThan(0);
  });
});

describe('engine: restart and shutdown', () => {
  it('resumes retry counters from monitor_state after a restart', async () => {
    start();
    const m = await createMonitor({ maxRetries: 2, retryIntervalS: 20 });
    results.set(m.uid, { status: 'down', msg: 'nope' });
    await clock.advance(1);
    await clock.advance(20 * SEC);
    flush();
    expect(state(m.id)).toMatchObject({ status: 2, retries: 2 });
    await engine!.stop();
    // "restart": a new engine, the process-local state is gone
    processorFor(ctx).forget(m.id);
    start();
    await clock.advance(30 * SEC);
    flush();
    expect(state(m.id)).toMatchObject({ status: 0, retries: 3 });
    const hb = beats(m.id).map((b) => b.status);
    expect(hb).toEqual([2, 2, 0]);
  });

  it('stop() waits for in-flight checks (bounded) and flushes', async () => {
    start({ stopTimeoutMs: 50 });
    const m = await createMonitor({});
    let resolve: (() => void) | null = null;
    results.set(m.uid, () => new Promise((r) => (resolve = () => r({ status: 'up', msg: 'late', latencyMs: 1 }))));
    await clock.advance(1);
    const stopping = engine!.stop();
    (resolve as unknown as () => void)();
    await stopping;
    await settle();
    expect(beats(m.id).map((b) => b.msg)).toEqual(['late']);
    engine = null;
  });
});

describe('helpers', () => {
  it('destinationOf extracts the host', () => {
    expect(destinationOf('https://Example.com:8443/x')).toBe('example.com');
    expect(destinationOf('db.internal:5432')).toBe('db.internal');
    expect(destinationOf('[2001:db8::1]:53')).toBe('2001:db8::1');
    expect(destinationOf('example.org')).toBe('example.org');
    expect(destinationOf(null)).toBeNull();
  });
});
