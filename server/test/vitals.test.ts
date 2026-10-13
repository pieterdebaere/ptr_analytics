import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getLogNormalScore,
  metricScore,
  metricScore01,
  nearestRankIndex,
  rate,
  realExperienceScore,
} from '../src/stats/vitals-score.js';
import { DAY, IPHONE_UA, api, createTestApp, login, sendEvent, type TestApp } from './helpers.js';

const NOW = Date.UTC(2026, 5, 15, 12);

describe('scoring', () => {
  it('implements the Lighthouse log-normal curve', () => {
    expect(getLogNormalScore({ p10: 200, median: 600 }, 200)).toBeCloseTo(0.9, 6);
    expect(getLogNormalScore({ p10: 200, median: 600 }, 600)).toBeCloseTo(0.5, 6);
    expect(getLogNormalScore({ p10: 200, median: 600 }, 0)).toBe(1);
    expect(getLogNormalScore({ p10: 200, median: 600 }, 1e9)).toBe(0);
    expect(() => getLogNormalScore({ p10: 600, median: 200 }, 1)).toThrow();
    // analytic check: 1 - Phi(ln(v/median) / sigma), sigma = ln(median/p10) / 1.28155
    expect(metricScore01('LCP', 3000)).toBeCloseTo(0.7836, 2);
    expect(metricScore('LCP', 2500)).toBe(90);
    expect(metricScore('LCP', 4000)).toBe(50);
    expect(metricScore('CLS', 0)).toBe(100);
    expect(metricScore('INP', 100000)).toBe(0);
    let prev = 101;
    for (let v = 100; v < 10000; v += 250) {
      const s = metricScore('LCP', v);
      expect(s).toBeLessThanOrEqual(prev);
      prev = s;
    }
  });

  it('rates with web.dev thresholds', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 2501)).toBe('needs-improvement');
    expect(rate('LCP', 4000)).toBe('needs-improvement');
    expect(rate('LCP', 4001)).toBe('poor');
    expect(rate('CLS', 0.1)).toBe('good');
    expect(rate('CLS', 0.26)).toBe('poor');
    expect(rate('TTFB', 900)).toBe('needs-improvement');
  });

  it('computes the Real Experience Score with re-normalised weights', () => {
    expect(realExperienceScore({})).toBeNull();
    expect(realExperienceScore({ LCP: 2500 })).toBe(90);
    const both = realExperienceScore({ LCP: 4000, CLS: 0 });
    expect(both).toBe(Math.round(((0.5 * 0.3 + 1 * 0.25) / 0.55) * 100));
    // TTFB does not count
    expect(realExperienceScore({ TTFB: 100000, LCP: 2500 })).toBe(90);
  });

  it('uses the nearest-rank method', () => {
    expect(nearestRankIndex(1)).toBe(0);
    expect(nearestRankIndex(4)).toBe(2);
    expect(nearestRankIndex(8)).toBe(5);
    expect(nearestRankIndex(10)).toBe(7);
  });
});

describe('vitals endpoints', () => {
  let t: TestApp;
  let cookie: string;
  let siteId: string;

  const send = async (ts: number, path: string, metrics: Array<{ name: string; value: number }>, ua?: string): Promise<void> => {
    t.clock.t = ts;
    const res = await sendEvent(t.app, { site: siteId, type: 'vitals', url: `https://example.com${path}`, metrics }, ua ? { ua } : {});
    expect(res.statusCode).toBe(202);
  };

  beforeAll(async () => {
    t = await createTestApp({ now: NOW });
    cookie = await login(t.app);
    siteId = t.ctx.sites.create('Example', ['example.com'], NOW).id;
    const lcp = [1000, 1200, 1500, 1800, 2000, 2600, 3000, 5000];
    for (const [i, v] of lcp.entries()) {
      await send(NOW - DAY - i * 1000, i < 6 ? '/' : '/slow', [{ name: 'LCP', value: v }]);
    }
    const cls = [0.01, 0.05, 0.3, 0.02];
    for (const v of cls) await send(NOW - 1000, '/', [{ name: 'CLS', value: v }], IPHONE_UA);
    t.clock.t = NOW;
  });

  afterAll(async () => {
    await t.app.close();
  });

  const get = async (url: string): Promise<Record<string, unknown>> => {
    const res = await api(t.app, cookie, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  it('summarises p75, counts, scores and ratings', async () => {
    const s = (await get(`/api/sites/${siteId}/vitals/summary?period=7d`)) as {
      score: number;
      metrics: Record<string, { p75: number | null; count: number; score: number | null; rating: string | null }>;
    };
    expect(s.metrics['LCP']).toEqual({ p75: 2600, count: 8, score: metricScore('LCP', 2600), rating: 'needs-improvement' });
    expect(s.metrics['CLS']).toEqual({ p75: 0.05, count: 4, score: metricScore('CLS', 0.05), rating: 'good' });
    expect(s.metrics['INP']).toEqual({ p75: null, count: 0, score: null, rating: null });
    expect(s.metrics['TTFB']).toEqual({ p75: null, count: 0, score: null, rating: null });
    expect(s.score).toBe(realExperienceScore({ LCP: 2600, CLS: 0.05 }));
  });

  it('filters by device and path', async () => {
    const m = (await get(`/api/sites/${siteId}/vitals/summary?period=7d&device=mobile`)) as {
      metrics: Record<string, { count: number }>;
    };
    expect(m.metrics['LCP']?.count).toBe(0);
    expect(m.metrics['CLS']?.count).toBe(4);
    const p = (await get(`/api/sites/${siteId}/vitals/summary?period=7d&path=%2Fslow`)) as {
      metrics: Record<string, { p75: number; count: number }>;
    };
    expect(p.metrics['LCP']).toMatchObject({ p75: 5000, count: 2 });
    // non-vitals filters are ignored rather than failing
    expect((await api(t.app, cookie, 'GET', `/api/sites/${siteId}/vitals/summary?referrer=x`)).statusCode).toBe(200);
  });

  it('returns a per-bucket p75 timeseries and RES', async () => {
    const r = (await get(`/api/sites/${siteId}/vitals/timeseries?period=7d&metric=LCP`)) as {
      interval: string;
      points: Array<{ t: number; value: number | null; count: number }>;
    };
    expect(r.interval).toBe('day');
    expect(r.points).toHaveLength(7);
    expect(r.points[5]).toEqual({ t: Date.UTC(2026, 5, 14), value: 2600, count: 8 });
    expect(r.points[6]).toEqual({ t: Date.UTC(2026, 5, 15), value: null, count: 0 });

    const res = (await get(`/api/sites/${siteId}/vitals/timeseries?period=7d&metric=RES`)) as {
      points: Array<{ value: number | null; count: number }>;
    };
    expect(res.points[5]).toMatchObject({ value: metricScore('LCP', 2600), count: 8 });
    expect(res.points[6]).toMatchObject({ value: metricScore('CLS', 0.05), count: 4 });
    expect(res.points[0]).toMatchObject({ value: null, count: 0 });
  });

  it('breaks down by dimension sorted by count', async () => {
    const r = await get(`/api/sites/${siteId}/vitals/breakdown?period=7d&metric=LCP&dimension=path`);
    expect(r['rows']).toEqual([
      { value: '/', p75: 2000, count: 6, rating: 'good' },
      { value: '/slow', p75: 5000, count: 2, rating: 'poor' },
    ]);
  });

  it('validates metric and dimension', async () => {
    for (const url of [
      `/api/sites/${siteId}/vitals/timeseries?metric=FID`,
      `/api/sites/${siteId}/vitals/timeseries`,
      `/api/sites/${siteId}/vitals/breakdown?metric=RES&dimension=path`,
      `/api/sites/${siteId}/vitals/breakdown?metric=LCP&dimension=referrer`,
    ]) {
      expect((await api(t.app, cookie, 'GET', url)).statusCode, url).toBe(400);
    }
  });
});
