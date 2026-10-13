import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, MIN, api, createTestApp, login, pageview, sendEvent, type TestApp } from './helpers.js';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // Mon 2026-06-15 12:00Z

let t: TestApp;
let cookie: string;
let siteId: string;
let otherSite: string;

async function at(ts: number, fn: () => Promise<unknown>): Promise<void> {
  const saved = t.clock.t;
  t.clock.t = ts;
  try {
    await fn();
  } finally {
    t.clock.t = saved;
  }
}

beforeAll(async () => {
  t = await createTestApp({ now: NOW });
  cookie = await login(t.app);
  siteId = t.ctx.sites.create('Example', ['example.com'], NOW).id;
  otherSite = t.ctx.sites.create('Zeta', ['zeta.com'], NOW).id;
  const A = { ip: '198.51.100.1' };
  const B = { ip: '198.51.100.2' };
  const C = { ip: '198.51.100.3' };
  const D = { ip: '198.51.100.4' };

  // today: A views /a and /b (one session), B lands on /a from google and signs up
  await at(NOW - 2 * HOUR - 20 * MIN, () => sendEvent(t.app, pageview(siteId, 'https://example.com/a'), A));
  await at(NOW - 2 * HOUR + 5 * MIN, () => sendEvent(t.app, pageview(siteId, 'https://example.com/b?utm_source=newsletter'), A));
  await at(NOW - HOUR, () =>
    sendEvent(t.app, pageview(siteId, 'https://example.com/a', { referrer: 'https://www.google.com/' }), B),
  );
  await at(NOW - HOUR + MIN, () =>
    sendEvent(t.app, { site: siteId, type: 'event', url: 'https://example.com/a', name: 'Signup', props: { plan: 'pro', annual: true } }, B),
  );
  // yesterday: C views /a
  await at(NOW - DAY, () => sendEvent(t.app, pageview(siteId, 'https://example.com/a'), C));
  // previous 7d period: D views /x on 2026-06-05
  await at(Date.UTC(2026, 5, 5, 9), () => sendEvent(t.app, pageview(siteId, 'https://example.com/x'), D));
  // other site, today
  await at(NOW - 3 * HOUR, () => sendEvent(t.app, pageview(otherSite, 'https://zeta.com/'), A));
  // realtime: 2 minutes ago
  await at(NOW - 2 * MIN, () => sendEvent(t.app, pageview(otherSite, 'https://zeta.com/live'), B));
});

afterAll(async () => {
  await t.app.close();
});

const get = async (url: string): Promise<Record<string, unknown>> => {
  const res = await api(t.app, cookie, 'GET', url);
  expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
  return res.json() as Record<string, unknown>;
};

describe('summary', () => {
  it('computes visitors, pageviews, bounce rate, events and the previous period', async () => {
    const s = await get(`/api/sites/${siteId}/stats/summary?period=7d`);
    expect(s).toEqual({
      visitors: 3,
      pageviews: 4,
      bounceRate: 2 / 3,
      events: 1,
      previous: { visitors: 1, pageviews: 1, bounceRate: 1, events: 0 },
    });
  });

  it('returns null bounce rate when there are no sessions', async () => {
    const s = await get(`/api/sites/${siteId}/stats/summary?period=custom&from=2020-01-01&to=2020-01-31`);
    expect(s).toMatchObject({ visitors: 0, pageviews: 0, bounceRate: null, events: 0 });
  });

  it('applies filters, including referrer= meaning direct traffic', async () => {
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&referrer=`)).toMatchObject({ visitors: 2, pageviews: 3 });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&referrer=google.com`)).toMatchObject({
      visitors: 1,
      pageviews: 1,
      bounceRate: 1,
    });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&path=%2Fb`)).toMatchObject({ visitors: 1, pageviews: 1, bounceRate: 0 });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&utm_source=newsletter`)).toMatchObject({ visitors: 1 });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&country=`)).toMatchObject({ visitors: 3 });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&country=DE`)).toMatchObject({ visitors: 0 });
  });

  it('event filter restricts pageviews to visitors who triggered the event', async () => {
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&event=Signup`)).toMatchObject({
      visitors: 1,
      pageviews: 1,
      events: 1,
    });
    expect(await get(`/api/sites/${siteId}/stats/summary?period=7d&event=Nope`)).toMatchObject({ visitors: 0, events: 0 });
  });
});

describe('timeseries', () => {
  it('returns zero-filled daily buckets with distinct visitors', async () => {
    const r = (await get(`/api/sites/${siteId}/stats/timeseries?period=7d`)) as {
      interval: string;
      points: Array<{ t: number; visitors: number; pageviews: number }>;
    };
    expect(r.interval).toBe('day');
    expect(r.points).toHaveLength(7);
    expect(r.points.map((p) => p.t)).toEqual(Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 5, 9 + i)));
    expect(r.points.map((p) => p.visitors)).toEqual([0, 0, 0, 0, 0, 1, 2]);
    expect(r.points.map((p) => p.pageviews)).toEqual([0, 0, 0, 0, 0, 1, 3]);
  });

  it('includes a per-bucket bounce rate of sessions started in the bucket', async () => {
    type P = { points: Array<{ bounceRate: number | null }> };
    const r = (await get(`/api/sites/${siteId}/stats/timeseries?period=7d`)) as P;
    // today: A (2 pageviews) + B (1 pageview); yesterday: C (1 pageview)
    expect(r.points.map((p) => p.bounceRate)).toEqual([null, null, null, null, null, 1, 0.5]);
    const f = (await get(`/api/sites/${siteId}/stats/timeseries?period=7d&referrer=google.com`)) as P;
    expect(f.points.map((p) => p.bounceRate)).toEqual([null, null, null, null, null, null, 1]);
    const d = (await get(`/api/sites/${siteId}/stats/timeseries?period=7d&path=%2Fb`)) as P;
    expect(d.points.map((p) => p.bounceRate)).toEqual([null, null, null, null, null, null, 0]);
  });

  it('returns 24 hourly buckets for 24h', async () => {
    const r = (await get(`/api/sites/${siteId}/stats/timeseries?period=24h`)) as {
      interval: string;
      points: Array<{ t: number; visitors: number; pageviews: number }>;
    };
    expect(r.interval).toBe('hour');
    expect(r.points).toHaveLength(24);
    expect(r.points[23]?.t).toBe(NOW);
    expect(r.points[0]?.t).toBe(NOW - 23 * HOUR);
    // A was active in two different hours: counted in both hours, but once for the day
    expect(r.points[20]).toEqual({ t: NOW - 3 * HOUR, visitors: 1, pageviews: 1, bounceRate: 0 });
    // A's session started in the previous hour: no session starts here -> null
    expect(r.points[21]).toEqual({ t: NOW - 2 * HOUR, visitors: 1, pageviews: 1, bounceRate: null });
    expect(r.points[22]).toEqual({ t: NOW - HOUR, visitors: 1, pageviews: 1, bounceRate: 1 });
    expect(r.points[0]).toEqual({ t: NOW - 23 * HOUR, visitors: 0, pageviews: 0, bounceRate: null });
  });

  it('returns monthly buckets for 12m and custom long ranges', async () => {
    const r = (await get(`/api/sites/${siteId}/stats/timeseries?period=12m`)) as { interval: string; points: Array<{ t: number; visitors: number }> };
    expect(r.interval).toBe('month');
    expect(r.points).toHaveLength(12);
    expect(r.points[0]?.t).toBe(Date.UTC(2025, 6, 1));
    expect(r.points[11]?.t).toBe(Date.UTC(2026, 5, 1));
    // 4 distinct visitors in June (A, B, C, D)
    expect(r.points[11]?.visitors).toBe(4);

    const c = (await get(`/api/sites/${siteId}/stats/timeseries?period=custom&from=2026-03-15&to=2026-06-20`)) as {
      interval: string;
      points: Array<{ t: number }>;
    };
    expect(c.interval).toBe('month');
    expect(c.points.map((p) => p.t)).toEqual([
      Date.UTC(2026, 2, 15),
      Date.UTC(2026, 3, 1),
      Date.UTC(2026, 4, 1),
      Date.UTC(2026, 5, 1),
    ]);
  });

  it('chooses hourly/daily intervals for custom ranges', async () => {
    const h = (await get(`/api/sites/${siteId}/stats/timeseries?period=custom&from=2026-06-14&to=2026-06-15`)) as { interval: string; points: unknown[] };
    expect(h.interval).toBe('hour');
    expect(h.points).toHaveLength(48);
    const d = (await get(`/api/sites/${siteId}/stats/timeseries?period=custom&from=2026-06-01&to=2026-06-03`)) as { interval: string; points: unknown[] };
    expect(d.interval).toBe('day');
    expect(d.points).toHaveLength(3);
  });

  it('applies filters to the timeseries', async () => {
    const r = (await get(`/api/sites/${siteId}/stats/timeseries?period=7d&event=Signup`)) as { points: Array<{ visitors: number }> };
    expect(r.points.map((p) => p.visitors)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });
});

describe('breakdowns', () => {
  it('breaks down pages by visitors', async () => {
    const r = await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=path`);
    expect(r).toEqual({
      dimension: 'path',
      rows: [
        { value: '/a', visitors: 3, count: 3 },
        { value: '/b', visitors: 1, count: 1 },
      ],
    });
  });

  it('includes null values (direct traffic) and honours limit', async () => {
    const r = await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=referrer`);
    expect(r['rows']).toEqual([
      { value: null, visitors: 2, count: 3 },
      { value: 'google.com', visitors: 1, count: 1 },
    ]);
    const l = await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=referrer&limit=1`);
    expect(l['rows']).toHaveLength(1);
  });

  it('breaks down custom events and their props', async () => {
    expect((await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=event`))['rows']).toEqual([
      { value: 'Signup', visitors: 1, count: 1 },
    ]);
    expect((await get(`/api/sites/${siteId}/stats/event-props?period=7d&event=Signup`))['rows']).toEqual([
      { key: 'annual', value: 'true', visitors: 1, count: 1 },
      { key: 'plan', value: 'pro', visitors: 1, count: 1 },
    ]);
    const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/event-props?period=7d`);
    expect(res.statusCode).toBe(400);
  });

  it('breaks down browser/device/os', async () => {
    expect((await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=browser`))['rows']).toEqual([
      { value: 'Chrome', visitors: 3, count: 4 },
    ]);
    expect((await get(`/api/sites/${siteId}/stats/breakdown?period=7d&dimension=utm_source`))['rows']).toEqual([
      { value: null, visitors: 3, count: 3 },
      { value: 'newsletter', visitors: 1, count: 1 },
    ]);
  });
});

describe('realtime and overview', () => {
  it('counts visitors in the last 5 minutes', async () => {
    expect(await get(`/api/sites/${otherSite}/stats/realtime`)).toEqual({ visitors: 1 });
    expect(await get(`/api/sites/${siteId}/stats/realtime`)).toEqual({ visitors: 0 });
  });

  it('returns all sites with visitors, previous visitors and a series', async () => {
    const r = (await get(`/api/overview?period=7d`)) as {
      sites: Array<{ id: string; name: string; domains: string[]; visitors: number; pageviews: number; previousVisitors: number; series: number[] }>;
    };
    expect(r.sites).toHaveLength(2);
    const ex = r.sites.find((s) => s.id === siteId);
    expect(ex).toEqual({
      id: siteId,
      name: 'Example',
      domains: ['example.com'],
      visitors: 3,
      pageviews: 4,
      previousVisitors: 1,
      series: [0, 0, 0, 0, 0, 1, 2],
    });
    const z = r.sites.find((s) => s.id === otherSite);
    expect(z?.visitors).toBe(2);
  });
});

describe('query validation', () => {
  const bad = [
    'period=1y',
    'tz=Mars/Olympus',
    `tz=${'A'.repeat(65)}`,
    'tz=Europe/Berlin;DROP',
    'period=custom',
    'period=custom&from=2026-02-30&to=2026-03-01',
    'period=custom&from=2026-03-02&to=2026-03-01',
    'period=custom&from=2020-01-01&to=2026-01-01',
    'path=a&path=b',
    `path=${'x'.repeat(1025)}`,
  ];
  it.each(bad)('rejects %s', async (qs) => {
    const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/summary?${qs}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });

  it('validates breakdown dimension and limit', async () => {
    for (const qs of ['dimension=password_hash', 'dimension=path&limit=0', 'dimension=path&limit=1001', 'dimension=path&limit=abc', '']) {
      const res = await api(t.app, cookie, 'GET', `/api/sites/${siteId}/stats/breakdown?${qs}`);
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it('requires auth and an existing site', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/sites/${siteId}/stats/summary` })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/overview' })).json()).toEqual({ error: 'unauthorized' });
    expect((await api(t.app, cookie, 'GET', '/api/sites/zzzzzzzzzzzz/stats/summary')).statusCode).toBe(404);
    expect((await api(t.app, cookie, 'GET', '/api/sites/..%2f/stats/summary')).statusCode).toBe(404);
  });
});

describe('time zones', () => {
  it('buckets days in the requested time zone across a DST change', async () => {
    const tz = await createTestApp({ now: Date.UTC(2026, 9, 27, 12) }); // Tue 2026-10-27
    try {
      const c = await login(tz.app);
      const id = tz.ctx.sites.create('TZ', ['example.com'], tz.clock.t).id;
      const send = async (ts: number, ip: string): Promise<void> => {
        tz.clock.t = ts;
        await sendEvent(tz.app, pageview(id, 'https://example.com/'), { ip });
      };
      // Europe/Berlin: CEST -> CET on Sun 2026-10-25 at 01:00Z
      await send(Date.UTC(2026, 9, 24, 21, 30), '192.0.2.1'); // Sat 23:30 CEST -> Oct 24
      await send(Date.UTC(2026, 9, 24, 22, 30), '192.0.2.2'); // Sun 00:30 CEST -> Oct 25
      await send(Date.UTC(2026, 9, 25, 22, 30), '192.0.2.3'); // Sun 23:30 CET  -> Oct 25 (25h day)
      await send(Date.UTC(2026, 9, 25, 23, 30), '192.0.2.4'); // Mon 00:30 CET  -> Oct 26
      tz.clock.t = Date.UTC(2026, 9, 27, 12);

      const res = await api(tz.app, c, 'GET', `/api/sites/${id}/stats/timeseries?period=7d&tz=Europe%2FBerlin`);
      const r = res.json() as { points: Array<{ t: number; visitors: number }> };
      expect(r.points.map((p) => p.t)).toEqual([
        Date.UTC(2026, 9, 20, 22),
        Date.UTC(2026, 9, 21, 22),
        Date.UTC(2026, 9, 22, 22),
        Date.UTC(2026, 9, 23, 22),
        Date.UTC(2026, 9, 24, 22), // Oct 25 starts at 00:00 CEST
        Date.UTC(2026, 9, 25, 23), // Oct 26 starts at 00:00 CET
        Date.UTC(2026, 9, 26, 23),
      ]);
      expect(r.points.map((p) => p.visitors)).toEqual([0, 0, 0, 1, 2, 1, 0]);

      // UTC view of the same data differs
      const u = (await api(tz.app, c, 'GET', `/api/sites/${id}/stats/timeseries?period=7d&tz=UTC`)).json() as {
        points: Array<{ visitors: number }>;
      };
      expect(u.points.map((p) => p.visitors)).toEqual([0, 0, 0, 2, 2, 0, 0]);

      // hourly custom range on the DST day has 25 buckets
      const h = (await api(tz.app, c, 'GET', `/api/sites/${id}/stats/timeseries?period=custom&from=2026-10-25&to=2026-10-25&tz=Europe%2FBerlin`)).json() as {
        interval: string;
        points: Array<{ t: number; visitors: number }>;
      };
      expect(h.interval).toBe('hour');
      expect(h.points).toHaveLength(25);
      expect(h.points[0]?.t).toBe(Date.UTC(2026, 9, 24, 22));
      expect(h.points.reduce((a, p) => a + p.visitors, 0)).toBe(2);

      // previous period of a custom range is the same number of days before it
      const s = (await api(tz.app, c, 'GET', `/api/sites/${id}/stats/summary?period=custom&from=2026-10-26&to=2026-10-26&tz=Europe%2FBerlin`)).json() as {
        visitors: number;
        previous: { visitors: number };
      };
      expect(s.visitors).toBe(1);
      expect(s.previous.visitors).toBe(2);
    } finally {
      await tz.app.close();
    }
  });
});
