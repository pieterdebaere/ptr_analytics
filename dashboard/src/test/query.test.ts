import { describe, expect, it } from 'vitest';
import {
  addDays,
  exportUrl,
  isValidDate,
  parseFilters,
  parsePeriod,
  periodSearch,
  statsParams,
  validateCustomRange,
  vitalsParams,
  withFilter,
  withPeriod,
} from '../lib/query';

describe('isValidDate', () => {
  it('accepts real dates only', () => {
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-01')).toBe(false);
    expect(isValidDate('26-01-01')).toBe(false);
    expect(isValidDate(' 2026-01-01')).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
  });
});

describe('validateCustomRange', () => {
  it('validates order and span', () => {
    expect(validateCustomRange('2026-01-01', '2026-01-31')).toBeNull();
    expect(validateCustomRange('2026-01-01', '2026-01-01')).toBeNull();
    expect(validateCustomRange('2026-02-01', '2026-01-31')).toMatch(/before/);
    expect(validateCustomRange('2020-01-01', '2026-01-31')).toMatch(/3 years/);
    expect(validateCustomRange(undefined, '2026-01-31')).not.toBeNull();
  });
});

describe('parsePeriod', () => {
  it('defaults to 7d', () => {
    expect(parsePeriod(new URLSearchParams(''))).toEqual({ period: '7d' });
    expect(parsePeriod(new URLSearchParams('period=bogus'))).toEqual({ period: '7d' });
  });
  it('parses presets', () => {
    for (const p of ['24h', '7d', '30d', '90d', '12m'] as const) {
      expect(parsePeriod(new URLSearchParams(`period=${p}`))).toEqual({ period: p });
    }
  });
  it('parses valid custom ranges and rejects invalid ones', () => {
    expect(parsePeriod(new URLSearchParams('period=custom&from=2026-01-01&to=2026-01-31'))).toEqual({
      period: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(parsePeriod(new URLSearchParams('period=custom&from=2026-01-31'))).toEqual({ period: '7d' });
    expect(parsePeriod(new URLSearchParams('period=custom&from=2026-02-01&to=2026-01-01'))).toEqual({ period: '7d' });
  });
});

describe('parseFilters', () => {
  it('keeps allow-listed keys, including empty values (IS NULL)', () => {
    const f = parseFilters(new URLSearchParams('path=/blog&referrer=&foo=bar&country=BE&utm_source=x'));
    expect(f).toEqual({ path: '/blog', referrer: '', country: 'BE', utm_source: 'x' });
  });
  it('drops over-long values', () => {
    const f = parseFilters(new URLSearchParams({ path: `/${'a'.repeat(1024)}` }));
    expect(f).toEqual({});
  });
});

describe('withPeriod / withFilter / periodSearch', () => {
  it('omits the default period and keeps filters', () => {
    const p = withPeriod(new URLSearchParams('period=30d&path=/blog'), { period: '7d' });
    expect(p.toString()).toBe('path=%2Fblog');
  });
  it('sets custom range', () => {
    const p = withPeriod(new URLSearchParams('path=/x'), { period: 'custom', from: '2026-01-01', to: '2026-01-02' });
    expect(p.get('period')).toBe('custom');
    expect(p.get('from')).toBe('2026-01-01');
    expect(p.get('to')).toBe('2026-01-02');
    expect(p.get('path')).toBe('/x');
    // switching back removes from/to
    const q = withPeriod(p, { period: '30d' });
    expect(q.has('from')).toBe(false);
    expect(q.get('period')).toBe('30d');
  });
  it('adds and removes filters without mutating the input', () => {
    const base = new URLSearchParams('period=30d');
    const withRef = withFilter(base, 'referrer', '');
    expect(withRef.toString()).toBe('period=30d&referrer=');
    expect(base.toString()).toBe('period=30d');
    expect(withFilter(withRef, 'referrer', null).toString()).toBe('period=30d');
  });
  it('periodSearch keeps only the period', () => {
    expect(periodSearch(new URLSearchParams('period=30d&path=/a'))).toBe('?period=30d');
    expect(periodSearch(new URLSearchParams('path=/a'))).toBe('');
  });
});

describe('statsParams / exportUrl / vitalsParams', () => {
  it('builds the stats query string with tz and filters', () => {
    const p = statsParams(
      { period: '30d', tz: 'Europe/Brussels', filters: { path: '/blog', referrer: '' } },
      { dimension: 'country', limit: 10 },
    );
    expect(p.toString()).toBe('period=30d&tz=Europe%2FBrussels&path=%2Fblog&referrer=&dimension=country&limit=10');
  });
  it('includes from/to for custom', () => {
    const p = statsParams({ period: 'custom', from: '2026-01-01', to: '2026-01-31', tz: 'UTC' });
    expect(p.toString()).toBe('period=custom&from=2026-01-01&to=2026-01-31&tz=UTC');
  });
  it('builds a same-origin export URL', () => {
    expect(exportUrl('abc123def456', { period: '7d', tz: 'UTC', filters: { country: 'BE' } })).toBe(
      '/api/sites/abc123def456/export?period=7d&tz=UTC&country=BE',
    );
    expect(exportUrl('../x', { period: '7d', tz: 'UTC' })).toBe('/api/sites/..%2Fx/export?period=7d&tz=UTC');
  });
  it('builds vitals params', () => {
    expect(vitalsParams({ period: '7d', tz: 'UTC', device: 'mobile', path: '/' }, { metric: 'LCP' }).toString()).toBe(
      'period=7d&tz=UTC&device=mobile&path=%2F&metric=LCP',
    );
  });
});

describe('addDays', () => {
  it('shifts dates across months', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
