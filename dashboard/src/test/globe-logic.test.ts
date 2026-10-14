import { describe, expect, it } from 'vitest';
import { initialDemoCountries, mulberry32, pickWeightedCountry } from '../components/globe/demo';
import { countryCentroid } from '../components/globe/geo';
import { contrastRatio, mix, parseColor, rgba } from '../components/globe/palette';
import { PingTracker } from '../components/globe/pings';
import {
  clampZoom,
  createIntensityScale,
  hashString,
  intensityBucket,
  jitterOffset,
  MAX_ZOOM,
  MIN_ZOOM,
  markerRadius,
  wrapLon,
} from '../components/globe/scales';
import { applyDrag, decayVelocity, MAX_TILT, pinchZoom, wheelZoomFactor } from '../components/globe/view';

describe('scales', () => {
  it('maps values to a 0..1 log intensity', () => {
    const s = createIntensityScale([1, 10, 1000]);
    expect(s(1000)).toBe(1);
    expect(s(0)).toBe(0);
    expect(s(-5)).toBe(0);
    expect(s(Number.NaN)).toBe(0);
    expect(s(10)).toBeGreaterThan(s(1));
    expect(s(10)).toBeLessThan(1);
    expect(s(5000)).toBe(1);
    // log scale keeps small countries visible
    expect(s(10)).toBeGreaterThan(0.3);
    expect(createIntensityScale([])(10)).toBe(0);
    expect(createIntensityScale([0, 0])(0)).toBe(0);
  });

  it('marker radius grows with intensity within bounds', () => {
    expect(markerRadius(0)).toBeCloseTo(1.75);
    expect(markerRadius(1)).toBeCloseTo(5.5);
    expect(markerRadius(0.5)).toBeGreaterThan(markerRadius(0.25));
    expect(markerRadius(7)).toBeCloseTo(5.5);
    expect(markerRadius(Number.NaN)).toBeCloseTo(1.75);
  });

  it('buckets intensities', () => {
    expect(intensityBucket(0, 5)).toBe(0);
    expect(intensityBucket(0.01, 5)).toBe(1);
    expect(intensityBucket(1, 5)).toBe(5);
    expect(intensityBucket(0.5, 5)).toBe(3);
  });

  it('clamps zoom', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('jitters deterministically inside the radius', () => {
    expect(jitterOffset('abc', 1)).toEqual(jitterOffset('abc', 1));
    expect(jitterOffset('abc', 1)).not.toEqual(jitterOffset('abd', 1));
    for (let i = 0; i < 200; i++) {
      const [dx, dy] = jitterOffset(`id-${i}`, 0.8);
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.8 + 1e-9);
    }
    expect(jitterOffset('x', 0)).toEqual([0, 0]);
    expect(hashString('')).toBe(0x811c9dc5);
  });

  it('wraps longitudes', () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(540)).toBe(-180);
    expect(wrapLon(10)).toBe(10);
  });
});

describe('view interaction maths', () => {
  it('drags the centre opposite to the pointer and clamps the tilt', () => {
    const v = { lon: 0, lat: 0, zoom: 1 };
    const right = applyDrag(v, 100, 0, 200);
    expect(right.lon).toBeLessThan(0);
    const down = applyDrag(v, 0, 10000, 200);
    expect(down.lat).toBe(MAX_TILT);
  });

  it('decays inertia', () => {
    expect(decayVelocity(1, 0)).toBe(1);
    expect(decayVelocity(1, 320)).toBeCloseTo(Math.exp(-1));
    expect(decayVelocity(1, 5000)).toBeLessThan(0.0001);
  });

  it('normalises wheel and pinch zoom', () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false })).toBeGreaterThan(1);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false })).toBeLessThan(1);
    expect(wheelZoomFactor({ deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeGreaterThan(1);
    // trackpad pinch (ctrl+wheel) is more sensitive per delta unit
    expect(wheelZoomFactor({ deltaY: -5, deltaMode: 0, ctrlKey: true })).toBeGreaterThan(
      wheelZoomFactor({ deltaY: -5, deltaMode: 0, ctrlKey: false }),
    );
    expect(wheelZoomFactor({ deltaY: -1e9, deltaMode: 0, ctrlKey: false })).toBeCloseTo(Math.exp(0.5));
    expect(wheelZoomFactor({ deltaY: Number.NaN, deltaMode: 0, ctrlKey: false })).toBe(1);
    expect(pinchZoom(1, 100, 200)).toBe(2);
    expect(pinchZoom(4, 100, 1000)).toBe(MAX_ZOOM);
    expect(pinchZoom(1, 0, 100)).toBe(1);
  });
});

describe('PingTracker', () => {
  const locate = (p: { country: string }) => countryCentroid(p.country);

  it('animates each id once and ignores unknown countries', () => {
    const t = new PingTracker({ duration: 1000 });
    expect(t.ingest([{ id: 'a', country: 'BE' }, { id: 'b', country: 'ZZ' }], 0, locate)).toBe(1);
    expect(t.ingest([{ id: 'a', country: 'BE' }, { id: 'b', country: 'ZZ' }], 10, locate)).toBe(0);
    expect(t.activeCount).toBe(1);
    expect(t.hasSeen('b')).toBe(true);
    expect(t.ingest(undefined, 0, locate)).toBe(0);
    expect(t.ingest([], 0, locate)).toBe(0);
  });

  it('expires pings after the duration', () => {
    const t = new PingTracker({ duration: 1000 });
    t.ingest([{ id: 'a', country: 'US' }], 0, locate);
    t.ingest([{ id: 'b', country: 'US' }], 500, locate);
    expect(t.nextExpiry(600)).toBe(400);
    expect(t.prune(999)).toHaveLength(2);
    expect(t.prune(1200)).toHaveLength(1);
    const remaining = t.prune(1200)[0];
    expect(remaining && t.progress(remaining, 1000)).toBeCloseTo(0.5);
    expect(t.prune(1600)).toHaveLength(0);
    expect(t.nextExpiry(1600)).toBeNull();
  });

  it('bounds the seen set and active list', () => {
    const t = new PingTracker({ maxSeen: 10, maxActive: 3 });
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, country: 'DE' }));
    t.ingest(many, 0, locate);
    expect(t.seenCount).toBe(10);
    expect(t.activeCount).toBe(3);
    expect(t.hasSeen('p0')).toBe(false);
    expect(t.hasSeen('p24')).toBe(true);
    // an evicted id would animate again, which is acceptable for very old pings
    t.markSeen([{ id: 'x', country: 'DE' }]);
    expect(t.ingest([{ id: 'x', country: 'DE' }], 0, locate)).toBe(0);
  });
});

describe('palette helpers', () => {
  it('parses canvas colour serialisations', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.5, 2);
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('oklch(0.5 0 0)')).toBeNull();
    expect(parseColor('nonsense')).toBeNull();
  });

  it('mixes and measures contrast', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(mix(black, white, 0.5).r).toBe(128);
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    expect(rgba(white, 0.25)).toBe('rgba(255,255,255,0.25)');
  });
});

describe('demo traffic', () => {
  it('is deterministic and weighted', () => {
    expect(initialDemoCountries()).toEqual(initialDemoCountries());
    const first = initialDemoCountries()[0];
    expect(first?.country).toBe('US');
    const rnd = mulberry32(1);
    const counts = new Map<string, number>();
    for (let i = 0; i < 5000; i++) {
      const c = pickWeightedCountry(rnd());
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.get('US') ?? 0).toBeGreaterThan(counts.get('BE') ?? 0);
    for (const c of counts.keys()) expect(countryCentroid(c), c).not.toBeNull();
    expect(pickWeightedCountry(0)).toBe('US');
    expect(pickWeightedCountry(1)).toMatch(/^[A-Z]{2}$/);
  });
});
