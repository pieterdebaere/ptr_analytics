import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, beatContributions, gapCapMs, splitRange, uptimeRatio } from '../src/uptime/engine/aggregate.js';

const T0 = Date.UTC(2026, 5, 15, 10, 0, 0);
const MIN = 60_000;

describe('splitRange', () => {
  it('splits across bucket boundaries', () => {
    expect(splitRange(T0 + 50 * MIN, T0 + 70 * MIN, HOUR_MS)).toEqual([
      { bucket: T0, ms: 10 * MIN },
      { bucket: T0 + HOUR_MS, ms: 10 * MIN },
    ]);
  });

  it('spans several buckets and empty ranges', () => {
    const parts = splitRange(T0 + 30 * MIN, T0 + 3 * HOUR_MS + 15 * MIN, HOUR_MS);
    expect(parts.map((p) => p.ms)).toEqual([30 * MIN, 60 * MIN, 60 * MIN, 15 * MIN]);
    expect(parts.reduce((s, p) => s + p.ms, 0)).toBe(2 * HOUR_MS + 45 * MIN);
    expect(splitRange(T0, T0, HOUR_MS)).toEqual([]);
    expect(splitRange(T0, T0 - 1, HOUR_MS)).toEqual([]);
  });

  it('days are UTC aligned', () => {
    const midnight = Date.UTC(2026, 5, 16);
    const parts = splitRange(midnight - HOUR_MS, midnight + 2 * HOUR_MS, DAY_MS);
    expect(parts).toEqual([
      { bucket: midnight - DAY_MS, ms: HOUR_MS },
      { bucket: midnight, ms: 2 * HOUR_MS },
    ]);
  });
});

describe('beatContributions (time weighted)', () => {
  const cap = gapCapMs(60, 60, 10_000); // 75 s

  it('the previous status holds until the new beat', () => {
    const m = beatContributions({ ts: T0, status: 1 }, { ts: T0 + MIN, status: 0, latencyMs: null, counted: true }, cap, HOUR_MS);
    const d = m.get(T0);
    expect(d).toMatchObject({ up_ms: MIN, down_ms: 0, checks: 1, failures: 1, lat_n: 0 });
  });

  it('latency only counts for UP checks', () => {
    const m = beatContributions({ ts: T0, status: 1 }, { ts: T0 + MIN, status: 1, latencyMs: 120, counted: true }, cap, HOUR_MS);
    expect(m.get(T0)).toMatchObject({ up_ms: MIN, checks: 1, failures: 0, lat_n: 1, lat_sum: 120, lat_min: 120, lat_max: 120 });
  });

  it('gaps beyond interval + timeout + 5 s are no data', () => {
    const m = beatContributions({ ts: T0, status: 1 }, { ts: T0 + 10 * MIN, status: 1, latencyMs: 5, counted: true }, cap, HOUR_MS);
    expect(m.get(T0)?.up_ms).toBe(75_000);
  });

  it('a duration crossing an hour boundary is split', () => {
    const prev = { ts: T0 + HOUR_MS - 30_000, status: 0 };
    const m = beatContributions(prev, { ts: T0 + HOUR_MS + 30_000, status: 1, latencyMs: 9, counted: true }, cap, HOUR_MS);
    expect(m.get(T0)).toMatchObject({ down_ms: 30_000, checks: 0 });
    expect(m.get(T0 + HOUR_MS)).toMatchObject({ down_ms: 30_000, checks: 1, lat_n: 1 });
  });

  it('pending and maintenance have their own durations; maintenance beats are not checks', () => {
    const p = beatContributions({ ts: T0, status: 2 }, { ts: T0 + MIN, status: 3, latencyMs: null, counted: false }, cap, HOUR_MS);
    expect(p.get(T0)).toMatchObject({ pending_ms: MIN, checks: 0, failures: 0 });
    const m = beatContributions({ ts: T0, status: 3 }, { ts: T0 + MIN, status: 1, latencyMs: 1, counted: true }, cap, HOUR_MS);
    expect(m.get(T0)).toMatchObject({ maint_ms: MIN, up_ms: 0 });
  });

  it('first beat (no previous) and clock going backwards add no duration', () => {
    expect(beatContributions(null, { ts: T0, status: 1, latencyMs: 1, counted: true }, cap, HOUR_MS).get(T0)).toMatchObject({ up_ms: 0, checks: 1 });
    const back = beatContributions({ ts: T0 + MIN, status: 1 }, { ts: T0, status: 1, latencyMs: 1, counted: true }, cap, HOUR_MS);
    expect(back.get(T0)?.up_ms).toBe(0);
  });

  it('unknown previous status adds nothing', () => {
    const m = beatContributions({ ts: T0, status: -1 }, { ts: T0 + MIN, status: 1, latencyMs: 1, counted: true }, cap, HOUR_MS);
    expect(m.get(T0)).toMatchObject({ up_ms: 0, down_ms: 0, pending_ms: 0, maint_ms: 0 });
  });
});

describe('uptimeRatio', () => {
  it('excludes maintenance and no-data, counts pending as unavailable', () => {
    expect(uptimeRatio({ up_ms: 50, down_ms: 25, pending_ms: 25 })).toBe(0.5);
    expect(uptimeRatio({ up_ms: 0, down_ms: 0, pending_ms: 0 })).toBeNull();
  });

  it('is time weighted, not count based (ANALYSIS §1.6 example)', () => {
    // 10 min DOWN checked every 20 s, 50 min UP checked every 60 s
    let prev: { ts: number; status: number } | null = null;
    let up = 0;
    let down = 0;
    const capDown = gapCapMs(60, 20, 10_000);
    const beats: Array<{ ts: number; status: number }> = [];
    for (let t = 0; t < 10 * MIN; t += 20_000) beats.push({ ts: T0 + t, status: 0 });
    for (let t = 10 * MIN; t <= 60 * MIN; t += MIN) beats.push({ ts: T0 + t, status: 1 });
    for (const b of beats) {
      for (const d of beatContributions(prev, { ...b, latencyMs: null, counted: true }, capDown, DAY_MS).values()) {
        up += d.up_ms;
        down += d.down_ms;
      }
      prev = b;
    }
    expect(uptimeRatio({ up_ms: up, down_ms: down, pending_ms: 0 })).toBeCloseTo(50 / 60, 5);
  });
});
