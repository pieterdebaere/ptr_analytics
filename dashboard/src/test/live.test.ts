import { describe, expect, it } from 'vitest';
import { appendSample, diffRecent, globeCountries, isoCountry, mergePings, pingId, relativeTime } from '../lib/live';

const NOW = Date.UTC(2026, 9, 13, 12);

describe('live ping diffing', () => {
  const recent = [
    { ts: NOW - 1_000, country: 'BE', path: '/a' },
    { ts: NOW - 5_000, country: 'us', path: '/b' },
    { ts: NOW - 8_000, country: null, path: '/c' },
    { ts: NOW - 9_000, country: '<b>', path: '/d' },
    { ts: NOW - 120_000, country: 'DE', path: '/old' },
  ];

  it('builds ids from ts, country and path', () => {
    expect(pingId(recent[0]!)).toBe(`${NOW - 1000}-BE-/a`);
    expect(pingId(recent[2]!)).toBe(`${NOW - 8000}-null-/c`);
  });

  it('emits only new, recent entries with a valid country', () => {
    const first = diffRecent(new Set(), recent, NOW);
    expect(first.pings).toEqual([
      { id: `${NOW - 1000}-BE-/a`, country: 'BE' },
      { id: `${NOW - 5000}-us-/b`, country: 'US' },
    ]);
    // every id is remembered (also the ones without a ping)
    expect(first.seen.size).toBe(5);

    const next = [{ ts: NOW + 4_000, country: 'FR', path: '/new' }, ...recent.slice(0, 3)];
    const second = diffRecent(first.seen, next, NOW + 5_000);
    expect(second.pings).toEqual([{ id: `${NOW + 4000}-FR-/new`, country: 'FR' }]);
    // memory is bounded to the latest response
    expect([...second.seen]).toEqual(next.map(pingId));
  });

  it('ignores malformed entries', () => {
    const r = diffRecent(new Set(), [null as never, { ts: 'x', country: 'BE', path: '/' } as never], NOW);
    expect(r.pings).toEqual([]);
  });

  it('merges pings newest first, de-duplicated and capped', () => {
    const a = [{ id: '1', country: 'BE' }];
    expect(mergePings(a, [])).toBe(a);
    expect(mergePings(a, [{ id: '2', country: 'US' }, { id: '1', country: 'BE' }])).toEqual([
      { id: '2', country: 'US' },
      { id: '1', country: 'BE' },
    ]);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), country: 'BE' }));
    expect(mergePings([], many, 3).map((p) => p.id)).toEqual(['0', '1', '2']);
  });
});

describe('live helpers', () => {
  it('validates countries', () => {
    expect(isoCountry('be')).toBe('BE');
    expect(isoCountry('XX')).toBeNull();
    expect(isoCountry('BEL')).toBeNull();
    expect(isoCountry(null)).toBeNull();
    expect(
      globeCountries([
        { country: 'us', visitors: 2 },
        { country: 'US', visitors: 3 },
        { country: null, visitors: 9 },
        { country: 'BE', visitors: 0 },
        { country: 'DE', visitors: 1 },
      ]),
    ).toEqual([
      { country: 'US', value: 5 },
      { country: 'DE', value: 1 },
    ]);
  });

  it('accumulates a windowed series', () => {
    let s = appendSample([], { time: 100, value: 1 }, 60);
    s = appendSample(s, { time: 105, value: 2 }, 60);
    s = appendSample(s, { time: 105, value: 3 }, 60); // same second: replaced
    expect(s).toEqual([
      { time: 100, value: 1 },
      { time: 105, value: 3 },
    ]);
    s = appendSample(s, { time: 170, value: 4 }, 60);
    expect(s).toEqual([{ time: 170, value: 4 }]);
    expect(appendSample(s, { time: Number.NaN, value: 1 })).toBe(s);
  });

  it('formats relative times', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 42_000, NOW)).toBe('42s ago');
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
  });
});
