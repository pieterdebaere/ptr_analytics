import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExportCursors } from '../src/stats/export.js';
import { StatsHandlers, type StatsOp } from '../src/stats/ops.js';
import { resolvePeriod } from '../src/stats/period.js';
import { WorkerPool, resolveWorkerEntry } from '../src/stats/pool.js';
import { statsService } from '../src/stats/service.js';
import { DAY, HOUR, api, createTestApp, login, pageview, sendEvent, tmpDir, type TestApp } from './helpers.js';

const NOW = Date.UTC(2026, 5, 15, 12);

/** Seeds a file database with a few hundred events / vitals spread over ~100 days. */
async function seed(t: TestApp, siteId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    t.clock.t = NOW - (i % 20) * DAY - i * HOUR;
    const ip = `198.51.100.${(i % 7) + 1}`;
    await sendEvent(t.app, pageview(siteId, `https://example.com/p${i % 5}?utm_source=s${i % 3}`), { ip });
    if (i % 4 === 0) {
      await sendEvent(t.app, { site: siteId, type: 'event', url: 'https://example.com/x', name: 'Signup', props: { plan: i % 8 ? 'pro' : 'free' } }, { ip });
    }
    await sendEvent(t.app, { site: siteId, type: 'vitals', url: `https://example.com/p${i % 3}`, metrics: [{ name: 'LCP', value: 1000 + i * 50 }, { name: 'CLS', value: i / 100 }] }, { ip });
  }
  t.clock.t = NOW;
  // bulk rows (same timestamp: keyset tie-breaks) + a malformed props value
  const ins = t.ctx.db.prepare(
    `INSERT INTO events (site_id, ts, type, name, visitor_id, session_id, hostname, path, props) VALUES (?, ?, ?, ?, 'v', 's', 'example.com', ?, ?)`,
  );
  t.ctx.db.transaction(() => {
    for (let i = 0; i < 2500; i++) ins.run(siteId, NOW - 3 * DAY, 'pageview', null, `/bulk/${i % 10}`, null);
    ins.run(siteId, NOW - 2 * DAY, 'event', 'Signup', '/x', 'not json');
  })();
}

describe('stats worker pool (file database)', () => {
  let t: TestApp;
  let cookie: string;
  let siteId: string;

  beforeAll(async () => {
    const dir = tmpDir();
    t = await createTestApp({ now: NOW, build: { dbPath: path.join(dir, 'analytics.db') } });
    cookie = await login(t.app);
    siteId = t.ctx.sites.create('Example', ['example.com'], NOW).id;
    t.ctx.sites.create('Other', ['other.com'], NOW);
    await seed(t, siteId);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('runs queries in worker threads with results identical to in-process execution', async () => {
    const service = statsService(t.ctx);
    expect(service.executor.mode).toBe('workers');
    const inline = new StatsHandlers(t.ctx.db);
    const range = resolvePeriod({ period: '90d', tz: 'Europe/Berlin' }, NOW);
    const filters = { columns: [] };
    const sites = t.ctx.sites.list().map((s) => ({ id: s.id, name: s.name, domains: s.domains }));
    const ops: StatsOp[] = [
      { kind: 'summary', siteId, range, filters },
      { kind: 'summary', siteId, range, filters: { columns: [{ key: 'path', value: '/p1' }], event: 'Signup' } },
      { kind: 'timeseries', siteId, range, filters },
      { kind: 'breakdown', siteId, range, filters, dimension: 'path', limit: 10 },
      { kind: 'breakdown', siteId, range, filters, dimension: 'event', limit: 10 },
      { kind: 'eventProps', siteId, range, filters, event: 'Signup', limit: 10 },
      { kind: 'realtime', siteId, now: NOW },
      { kind: 'overview', sites, range },
      { kind: 'vitalsSummary', siteId, range, filters },
      { kind: 'vitalsTimeseries', siteId, range, filters, metric: 'RES' },
      { kind: 'vitalsBreakdown', siteId, range, filters, metric: 'LCP', dimension: 'path', limit: 10 },
    ];
    for (const op of ops) {
      const { value } = await service.executor.run(op);
      expect(value, op.kind).toEqual(inline.run(op));
    }
    expect((service.executor as WorkerPool).threads).toBe(2);
  });

  it('serves the HTTP API from the workers', async () => {
    const inline = new StatsHandlers(t.ctx.db);
    const range = resolvePeriod({ period: '90d' }, NOW);
    const s = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/summary?period=90d`);
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual(inline.run({ kind: 'summary', siteId, range, filters: { columns: [] } }));
    expect((s.json() as { visitors: number }).visitors).toBeGreaterThan(5);
    const o = await api(t.app, cookie, 'GET', '/api/overview?period=30d');
    expect(o.statusCode).toBe(200);
    expect((o.json() as { sites: unknown[] }).sites).toHaveLength(2);
    // malformed props JSON is skipped, not an error
    const p = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/event-props?period=30d&event=Signup`);
    expect(p.statusCode).toBe(200);
    const rows = (p.json() as { rows: Array<{ key: string; value: string; count: number }> }).rows;
    expect(rows.map((r) => `${r.key}=${r.value}`).sort()).toEqual(['plan=free', 'plan=pro']);
    expect(rows.reduce((a, r) => a + r.count, 0)).toBe(10);
  });

  it('exports identical CSV through the workers, including keyset ties and the event filter', async () => {
    const service = statsService(t.ctx);
    const range = resolvePeriod({ period: '90d' }, NOW);
    for (const query of ['period=90d', 'period=90d&event=Signup', 'period=90d&path=%2Fbulk%2F3']) {
      const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/export?${query}`);
      expect(res.statusCode).toBe(200);
      const filters =
        query.includes('event') ? { columns: [], event: 'Signup' } : query.includes('bulk') ? { columns: [{ key: 'path' as const, value: '/bulk/3' }] } : { columns: [] };
      const cursors = new ExportCursors(t.ctx.db);
      const h = cursors.open({ siteId, from: range.from, to: range.to, filters });
      let expected = '';
      for (;;) {
        const b = cursors.next(h, 100_000);
        expected += b.csv;
        if (b.done) break;
      }
      const lines = res.body.split('\r\n').slice(1);
      expect(lines.join('\r\n')).toBe(expected);
      if (query === 'period=90d') expect(lines.length - 1).toBe(40 + 10 + 2500 + 1);
      if (query.includes('bulk')) expect(lines.length - 1).toBe(250);
    }
    expect(service.exportsInFlight).toBe(0);
  });

  it('stops an export and frees its slot when the client disconnects', async () => {
    const service = statsService(t.ctx);
    const big = t.ctx.sites.create('Big', ['big.com'], NOW).id;
    const ins = t.ctx.db.prepare(
      `INSERT INTO events (site_id, ts, type, visitor_id, session_id, hostname, path) VALUES (?, ?, 'pageview', 'v', 's', 'big.com', ?)`,
    );
    t.ctx.db.transaction(() => {
      for (let i = 0; i < 40_000; i++) ins.run(big, NOW - DAY - i * 1000, `/a-fairly-long-path/to/make/rows/bigger/${i}`);
    })();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/sites/${big}/export?period=90d`, headers: { cookie } },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', () => {
            expect(service.exportsInFlight).toBe(1);
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', (err) => (err.message.includes('aborted') || err.message.includes('socket hang up') ? resolve() : reject(err)));
    });
    for (let i = 0; i < 50 && service.exportsInFlight > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(service.exportsInFlight).toBe(0);
  });

  it('terminates the workers when the app closes', async () => {
    const dir = tmpDir();
    const other = await createTestApp({ now: NOW, build: { dbPath: path.join(dir, 'analytics.db') } });
    const c = await login(other.app);
    const id = other.ctx.sites.create('S', ['s.com'], NOW).id;
    expect((await api(other.app, c, 'GET', `/api/sites/${id}/stats/summary`)).statusCode).toBe(200);
    const pool = statsService(other.ctx).executor as WorkerPool;
    expect(pool.threads).toBe(2);
    await other.app.close();
    expect(pool.threads).toBe(0);
    await expect(pool.run({ kind: 'realtime', siteId: id, now: NOW })).rejects.toThrow();
  });
});

describe('WorkerPool time budget', () => {
  // A stand-in worker whose "query" busy-loops for op.now milliseconds.
  const slowWorker = new URL(
    `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', ({ id, op }) => {
        const end = Date.now() + op.now;
        while (Date.now() < end) {}
        parentPort.postMessage({ id, ok: true, value: op.siteId });
      });
      parentPort.postMessage({ ready: true });
    `)}`,
  );
  const op = (ms: number, tag = 'x') => ({ kind: 'realtime' as const, siteId: tag, now: ms });

  it('fails with 503 on timeout, replaces the worker and keeps serving', async () => {
    const pool = new WorkerPool('unused', { url: slowWorker }, 1, 300);
    try {
      expect((await pool.run(op(10, 'a'))).value).toBe('a');
      const slow = pool.run(op(5000, 'slow'));
      // queued behind the slow one: its budget runs out in the queue
      const queued = pool.run(op(10, 'queued'));
      await expect(slow).rejects.toMatchObject({ statusCode: 503, message: 'query timed out' });
      await expect(queued).rejects.toMatchObject({ statusCode: 503 });
      // the replacement worker serves new queries
      expect((await pool.run(op(10, 'b'))).value).toBe('b');
      expect(pool.threads).toBe(1);
    } finally {
      await pool.close();
    }
    expect(pool.threads).toBe(0);
  });

  it('pins ops to a worker and rejects pins of a replaced worker', async () => {
    const pool = new WorkerPool('unused', { url: slowWorker }, 2, 300);
    try {
      const first = await pool.run(op(1));
      const again = await pool.run(op(1), first.pin);
      expect(again.pin).toEqual(first.pin);
      await expect(pool.run(op(2000), first.pin)).rejects.toMatchObject({ statusCode: 503 });
      // that worker was replaced: the old pin is no longer valid
      for (let i = 0; i < 100; i++) {
        const r = await pool.run(op(1));
        if (r.pin.slot === first.pin.slot && r.pin.gen !== first.pin.gen) break;
      }
      await expect(pool.run(op(1), first.pin)).rejects.toThrow(/restarted/);
    } finally {
      await pool.close();
    }
  });

  it('resolves the worker entry from the TypeScript sources', () => {
    const entry = resolveWorkerEntry();
    expect(entry?.url.pathname).toMatch(/\/stats\/worker\.(ts|js)$/);
  });
});
