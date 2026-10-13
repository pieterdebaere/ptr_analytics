import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StatsOp } from '../src/stats/ops.js';
import type { Pin, Ran, StatsExecutor } from '../src/stats/pool.js';
import { queryTimedOut } from '../src/stats/pool.js';
import { DEFAULT_STATS_OPTIONS, StatsService, statsService } from '../src/stats/service.js';
import { api, createTestApp, login, pageview, sendEvent, type TestApp } from './helpers.js';

/** Wraps the real executor: counts calls and can hold ops until released. */
function instrument(service: StatsService): { calls: StatsOp[]; hold: () => () => void } {
  const executor = service.executor as StatsExecutor & { run: StatsExecutor['run'] };
  const original = executor.run.bind(executor);
  const calls: StatsOp[] = [];
  let gate: Promise<void> | null = null;
  executor.run = (async (op: StatsOp, pin?: Pin): Promise<Ran<unknown>> => {
    calls.push(op);
    if (gate) await gate;
    return original(op as never, pin);
  }) as StatsExecutor['run'];
  return {
    calls,
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('stats admission control, cache and fetch-site checks', () => {
  let t: TestApp;
  let cookie: string;
  let siteId: string;
  let probe: ReturnType<typeof instrument>;

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await login(t.app);
    siteId = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'));
    probe = instrument(statsService(t.ctx));
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('caches identical queries and coalesces concurrent ones', async () => {
    const url = `/api/sites/${siteId}/stats/summary?period=30d&path=%2F`;
    const before = probe.calls.length;
    const [a, b] = await Promise.all([api(t.app, cookie, 'GET', url), api(t.app, cookie, 'GET', url)]);
    const c = await api(t.app, cookie, 'GET', url);
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);
    expect(b.json()).toEqual(a.json());
    expect(c.json()).toEqual(a.json());
    expect(probe.calls.length - before).toBe(1);
    // other parameters, another time zone or another site are different entries
    await api(t.app, cookie, 'GET', `${url}&tz=Europe%2FBerlin`);
    await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/summary?period=7d&path=%2F`);
    expect(probe.calls.length - before).toBe(3);
    // realtime is never cached
    await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/realtime`);
    await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/realtime`);
    expect(probe.calls.length - before).toBe(5);
  });

  it('limits concurrent stats requests per user (429)', async () => {
    const release = probe.hold();
    const pending = Array.from({ length: 6 }, (_, i) => api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/summary?period=7d&path=%2Fp${i}`));
    for (let i = 0; i < 50 && statsService(t.ctx).inFlight < 6; i++) await tick();
    expect(statsService(t.ctx).inFlight).toBe(6);
    const over = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/timeseries?period=7d&path=%2Fover`);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'too many requests' });
    expect(over.headers['retry-after']).toBe('5');
    // cached results are still served while the user is at the limit
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/summary?period=30d&path=%2F`)).statusCode).toBe(200);
    release();
    expect((await Promise.all(pending)).map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statsService(t.ctx).inFlight).toBe(0);
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/timeseries?period=7d&path=%2Fover`)).statusCode).toBe(200);
  });

  it('maps query timeouts to 503', async () => {
    const executor = statsService(t.ctx).executor as StatsExecutor & { run: StatsExecutor['run'] };
    const run = executor.run;
    executor.run = (() => Promise.reject(queryTimedOut())) as StatsExecutor['run'];
    try {
      const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/vitals/summary?period=12m`);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'query timed out' });
    } finally {
      executor.run = run;
    }
    // a failed query is not cached
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/vitals/summary?period=12m`)).statusCode).toBe(200);
  });

  it('rejects heavy GETs initiated by other sites (Sec-Fetch-Site)', async () => {
    const urls = [
      `/api/sites/${siteId}/stats/summary`,
      `/api/sites/${siteId}/vitals/summary`,
      `/api/sites/${siteId}/export`,
      '/api/overview',
    ];
    for (const url of urls) {
      for (const site of ['cross-site', 'same-site', 'bogus']) {
        const res = await t.app.inject({ method: 'GET', url, headers: { cookie, 'sec-fetch-site': site } });
        expect(res.statusCode, `${url} ${site}`).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden' });
      }
      for (const site of ['same-origin', 'none', undefined]) {
        const headers: Record<string, string> = { cookie };
        if (site) headers['sec-fetch-site'] = site;
        expect((await t.app.inject({ method: 'GET', url, headers })).statusCode, `${url} ${site}`).toBe(200);
      }
    }
  });
});

describe('StatsService', () => {
  it('enforces the global in-flight limit across users', async () => {
    const t = await createTestApp();
    try {
      const service = new StatsService(t.ctx, { ...DEFAULT_STATS_OPTIONS, maxInFlight: 3, maxInFlightPerUser: 2, cacheTtlMs: 0 });
      const probe = instrument(service);
      const release = probe.hold();
      const op = (n: number): StatsOp => ({ kind: 'realtime', siteId: 'x', now: n });
      const p = [service.query('a', op(1)), service.query('a', op(2)), service.query('b', op(3))];
      await expect(service.query('a', op(4))).rejects.toMatchObject({ statusCode: 429 });
      await expect(service.query('c', op(5))).rejects.toMatchObject({ statusCode: 429 });
      release();
      expect(await Promise.all(p)).toEqual([0, 0, 0]);
      expect(await service.query('c', op(6))).toBe(0);
      await service.close();
    } finally {
      await t.app.close();
    }
  });

  it('expires cached results after the TTL', async () => {
    const t = await createTestApp();
    try {
      const service = new StatsService(t.ctx, { ...DEFAULT_STATS_OPTIONS, cacheTtlMs: 40 });
      const probe = instrument(service);
      const op: StatsOp = { kind: 'realtime', siteId: 'x', now: 1 };
      await service.query('a', op);
      await service.query('a', op);
      expect(probe.calls).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 60));
      await service.query('a', op);
      expect(probe.calls).toHaveLength(2);
      await service.close();
    } finally {
      await t.app.close();
    }
  });
});

describe('export limits', () => {
  let t: TestApp;
  let cookie: string;
  let siteId: string;

  beforeAll(async () => {
    t = await createTestApp();
    cookie = await login(t.app);
    siteId = t.ctx.sites.create('S', ['example.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'));
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('answers HEAD with headers only, without running the export', async () => {
    const service = statsService(t.ctx);
    const res = await t.app.inject({ method: 'HEAD', url: `/api/sites/${siteId}/export?period=7d`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ptr-analytics-/);
    expect(res.body).toBe('');
    expect(service.exportsInFlight).toBe(0);
    expect((await t.app.inject({ method: 'HEAD', url: `/api/sites/${siteId}/export` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'HEAD', url: `/api/sites/${siteId}/export?period=1y`, headers: { cookie } })).statusCode).toBe(400);
  });

  it('allows one export per user and two in total (429 beyond)', async () => {
    const service = statsService(t.ctx);
    const spec = { siteId, from: 0, to: t.clock.t + 1, filters: { columns: [] } };
    const admin = (await api(t.app, cookie, 'GET', '/api/auth/me')).json() as { user: { id: number } };
    const mine = await service.openExport(`u${admin.user.id}`, spec);
    const busy = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d`);
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toEqual({ error: 'too many requests' });
    expect(busy.headers['content-disposition']).toBeUndefined();
    mine.close();
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d`)).statusCode).toBe(200);

    const other1 = await service.openExport('someone', spec);
    const other2 = await service.openExport('someone-else', spec);
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d`)).statusCode).toBe(429);
    other1.close();
    other2.close();
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?period=7d`)).statusCode).toBe(200);
    expect(service.exportsInFlight).toBe(0);
  });
});
