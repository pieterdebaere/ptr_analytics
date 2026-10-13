import { describe, expect, it } from 'vitest';
import { areaPath, labelIndices, linePath, linearScale, nearestIndex, niceStep, niceTicks, pointX, segments } from '../lib/chart';

describe('niceStep / niceTicks', () => {
  it('rounds to nice steps', () => {
    expect(niceStep(0.75)).toBe(1);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(23)).toBe(25);
    expect(niceStep(180)).toBe(200);
  });
  it('produces integer ticks covering the max', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(97)).toEqual([0, 25, 50, 75, 100]);
    const t = niceTicks(1234);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1234);
    expect(t.every(Number.isInteger)).toBe(true);
  });
  it('supports fractional ticks', () => {
    expect(niceTicks(0.05, 4, false)).toEqual([0, 0.02, 0.04, 0.06]);
    expect(niceTicks(0.6, 4, false)).toEqual([0, 0.2, 0.4, 0.6]);
  });
});

describe('scales and positions', () => {
  it('maps linearly (inverted y)', () => {
    const y = linearScale(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(y(100)).toBe(0);
    expect(linearScale(5, 5, 10, 0)(5)).toBe(10);
  });
  it('places and finds points', () => {
    expect(pointX(0, 5, 0, 100)).toBe(0);
    expect(pointX(4, 5, 0, 100)).toBe(100);
    expect(pointX(0, 1, 0, 100)).toBe(50);
    expect(nearestIndex(26, 5, 0, 100)).toBe(1);
    expect(nearestIndex(-50, 5, 0, 100)).toBe(0);
    expect(nearestIndex(500, 5, 0, 100)).toBe(4);
  });
  it('picks label indices', () => {
    expect(labelIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(labelIndices(24, 6)).toEqual([0, 4, 8, 12, 16, 20]);
    expect(labelIndices(0, 6)).toEqual([]);
  });
});

describe('paths', () => {
  it('splits null gaps into segments', () => {
    const segs = segments([1, null, 2, 3], (i) => i * 10, (v) => v);
    expect(segs).toEqual([[{ x: 0, y: 1 }], [{ x: 20, y: 2 }, { x: 30, y: 3 }]]);
  });
  it('builds line and area paths', () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 10, y: 5 },
    ];
    expect(linePath(pts)).toBe('M0,10L10,5');
    expect(areaPath(pts, 20)).toBe('M0,10L10,5L10,20L0,20Z');
    expect(areaPath([], 20)).toBe('');
  });
});
