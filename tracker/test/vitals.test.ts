import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/glob';
import { clean, clsTracker, inpTracker } from '../src/vitals';

describe('clsTracker (session windows)', () => {
  const run = (entries: { startTime: number; value: number; hadRecentInput?: boolean }[]) => {
    const add = clsTracker();
    let v = 0;
    for (const e of entries) v = add(e);
    return v;
  };

  it('sums shifts within one window', () => {
    expect(run([{ startTime: 0, value: 0.1 }, { startTime: 500, value: 0.1 }, { startTime: 1400, value: 0.1 }])).toBeCloseTo(0.3);
  });

  it('starts a new window after a gap of >= 1s and reports the max window', () => {
    expect(
      run([
        { startTime: 0, value: 0.1 },
        { startTime: 500, value: 0.1 }, // window 1 = 0.2
        { startTime: 1500, value: 0.05 }, // gap 1000ms -> window 2
        { startTime: 2000, value: 0.05 }, // window 2 = 0.1
      ]),
    ).toBeCloseTo(0.2);
  });

  it('caps a window at 5s even when shifts keep coming', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ startTime: i * 900, value: 0.1 }));
    // 0..4500 (6 shifts, the next at 5400 is > 5s after window start) => 0.6; then a new window
    expect(run(entries)).toBeCloseTo(0.6);
  });

  it('ignores shifts with recent input', () => {
    expect(run([{ startTime: 0, value: 0.3, hadRecentInput: true }, { startTime: 10, value: 0.01 }])).toBeCloseTo(0.01);
  });

  it('is 0 without shifts', () => {
    expect(run([])).toBe(0);
  });
});

describe('inpTracker (~p98 of interactions)', () => {
  it('is undefined without interactions and ignores interactionId 0', () => {
    const t = inpTracker();
    expect(t.value()).toBeUndefined();
    t.add({ startTime: 0, duration: 500, interactionId: 0 });
    t.add({ startTime: 0, duration: 500 });
    expect(t.value()).toBeUndefined();
  });

  it('uses the longest entry per interaction', () => {
    const t = inpTracker();
    t.add({ startTime: 0, duration: 48, interactionId: 7 });
    t.add({ startTime: 0, duration: 200, interactionId: 7 });
    t.add({ startTime: 0, duration: 104, interactionId: 7 });
    t.add({ startTime: 0, duration: 64, interactionId: 14 });
    expect(t.value()).toBe(200);
  });

  it('is the worst interaction below 50 interactions', () => {
    const t = inpTracker();
    for (let i = 1; i <= 49; i++) t.add({ startTime: i, duration: i * 10, interactionId: i });
    expect(t.value()).toBe(490);
  });

  it('skips one outlier per 50 interactions', () => {
    const t = inpTracker();
    for (let i = 1; i <= 120; i++) t.add({ startTime: i, duration: i, interactionId: i });
    // 120 interactions -> index floor(120/50) = 2 -> third longest
    expect(t.value()).toBe(118);
  });

  it('uses performance.interactionCount when larger (fast interactions are not observed)', () => {
    const t = inpTracker();
    for (let i = 1; i <= 5; i++) t.add({ startTime: i, duration: 100 + i, interactionId: i });
    expect(t.value(5)).toBe(105);
    expect(t.value(100)).toBe(103); // index 2
    expect(t.value(10_000)).toBe(101); // clamped to the last candidate
  });
});

describe('clean', () => {
  it('rounds ms to integers and CLS to 4 decimals', () => {
    expect(clean('LCP', 1234.56)).toBe(1235);
    expect(clean('CLS', 0.123456)).toBe(0.1235);
    expect(clean('CLS', 0)).toBe(0);
  });

  it('drops values the server would reject', () => {
    expect(clean('LCP', undefined)).toBeUndefined();
    expect(clean('LCP', NaN)).toBeUndefined();
    expect(clean('LCP', -1)).toBeUndefined();
    expect(clean('LCP', 600_001)).toBeUndefined();
    expect(clean('CLS', 101)).toBeUndefined();
    expect(clean('INP', Infinity)).toBeUndefined();
  });
});

describe('globToRegExp', () => {
  const m = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('* matches within one segment', () => {
    expect(m('/preview/*', '/preview/abc')).toBe(true);
    expect(m('/preview/*', '/preview/')).toBe(true);
    expect(m('/preview/*', '/preview/a/b')).toBe(false);
    expect(m('/blog/*/edit', '/blog/post-1/edit')).toBe(true);
    expect(m('/blog/*/edit', '/blog/a/b/edit')).toBe(false);
  });

  it('** matches anything, a trailing /** also the bare prefix', () => {
    expect(m('/admin/**', '/admin')).toBe(true);
    expect(m('/admin/**', '/admin/')).toBe(true);
    expect(m('/admin/**', '/admin/users/1')).toBe(true);
    expect(m('/admin/**', '/administrator')).toBe(false);
    expect(m('/**/secret', '/a/b/secret')).toBe(true);
    expect(m('**', '/anything/at/all')).toBe(true);
  });

  it('matches whole paths and escapes regex characters', () => {
    expect(m('/a.b', '/a.b')).toBe(true);
    expect(m('/a.b', '/axb')).toBe(false);
    expect(m('/x', '/x/y')).toBe(false);
    expect(m(' /x ', '/x')).toBe(true);
    expect(m('/(group)+[x]', '/(group)+[x]')).toBe(true);
  });
});
