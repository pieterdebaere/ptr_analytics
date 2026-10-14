import { geoContains, geoOrthographic } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { describe, expect, it } from 'vitest';
import worldAtlas from 'world-atlas/countries-110m.json';
import { alpha2ForFeature, NAME_TO_ALPHA2, NUMERIC_TO_ALPHA2, normalizeAlpha2 } from '../components/globe/country-codes';
import {
  centroidCacheSize,
  countryCentroid,
  countrySpread,
  findCountryAt,
  getWorld,
  shapesForCode,
} from '../components/globe/geo';
import { computeLandDots, DEFAULT_DOT_STEP, rowLongitudes, shapeIndexAt } from '../components/globe/land-dots';
import { SMALL_TERRITORY_CENTROIDS } from '../components/globe/small-territories';
import { makeProjection, projectLonLat, viewTrig } from '../components/globe/view';

const topo = worldAtlas as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
const features = feature(topo, topo.objects.countries).features;

describe('country code table', () => {
  it('maps every world-atlas 110m feature to an alpha-2 code', () => {
    const unmapped = features.filter((f) => !alpha2ForFeature(f.id, f.properties?.name)).map((f) => `${f.id}:${f.properties?.name}`);
    expect(unmapped).toEqual([]);
    expect(features.length).toBeGreaterThan(170);
  });

  it('has 249 unique, well-formed ISO entries', () => {
    const keys = Object.keys(NUMERIC_TO_ALPHA2);
    const values = Object.values(NUMERIC_TO_ALPHA2);
    expect(keys).toHaveLength(249);
    for (const k of keys) expect(k).toMatch(/^\d{3}$/);
    for (const v of values) expect(v).toMatch(/^[A-Z]{2}$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it('only uses codes that Intl knows as regions', () => {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    for (const code of [...Object.values(NUMERIC_TO_ALPHA2), ...Object.values(NAME_TO_ALPHA2)]) {
      const n = names.of(code);
      expect(n, code).toBeTruthy();
      expect(n, code).not.toBe('Unknown Region');
    }
  });

  it('spot-checks well known countries', () => {
    expect(alpha2ForFeature('056')).toBe('BE');
    expect(alpha2ForFeature(840)).toBe('US');
    expect(alpha2ForFeature('76')).toBe('BR');
    expect(alpha2ForFeature('276')).toBe('DE');
    expect(alpha2ForFeature(undefined, 'Kosovo')).toBe('XK');
    expect(alpha2ForFeature(undefined, 'Atlantis')).toBeNull();
  });

  it('normalises untrusted alpha-2 input', () => {
    expect(normalizeAlpha2(' be ')).toBe('BE');
    expect(normalizeAlpha2('BEL')).toBeNull();
    expect(normalizeAlpha2(null)).toBeNull();
    expect(normalizeAlpha2(42)).toBeNull();
    expect(normalizeAlpha2('<x>')).toBeNull();
  });
});

describe('world geometry', () => {
  it('indexes shapes by code with the ISO feature first', () => {
    const world = getWorld();
    expect(getWorld()).toBe(world);
    expect(shapesForCode('CY')[0]?.name).toBe('Cyprus');
    expect(shapesForCode('SO')[0]?.name).toBe('Somalia');
    expect(shapesForCode('so')).toHaveLength(2);
    expect(shapesForCode('ZZ')).toEqual([]);
    expect(shapesForCode(null)).toEqual([]);
  });

  it('caches centroids and places them on the main landmass', () => {
    const fr = countryCentroid('FR');
    expect(countryCentroid('fr')).toBe(fr);
    const size = centroidCacheSize();
    countryCentroid('FR');
    expect(centroidCacheSize()).toBe(size);
    for (const code of ['FR', 'US', 'NO', 'BE', 'DE', 'BR', 'IN', 'RU', 'CA', 'NL', 'GB', 'AU', 'ES']) {
      const c = countryCentroid(code);
      expect(c, code).not.toBeNull();
      const shape = shapesForCode(code)[0];
      expect(shape && c && geoContains(shape.feature, c), code).toBe(true);
    }
    // France: metropolitan, not dragged towards French Guiana
    expect(fr?.[0]).toBeGreaterThan(-5);
    expect(fr?.[1]).toBeGreaterThan(42);
  });

  it('falls back to small-territory centroids and ignores unknown codes', () => {
    expect(countryCentroid('SG')).toEqual(SMALL_TERRITORY_CENTROIDS.SG);
    expect(countryCentroid('ZZ')).toBeNull();
    expect(countryCentroid('')).toBeNull();
    expect(countryCentroid(undefined)).toBeNull();
    expect(countrySpread('ZZ')).toBe(0);
    expect(countrySpread('US')).toBeGreaterThan(countrySpread('BE'));
  });

  it('hit-tests points', () => {
    expect(findCountryAt(4.4, 50.8)?.code).toBe('BE');
    expect(findCountryAt(-100, 40)?.code).toBe('US');
    expect(findCountryAt(-30, 30)).toBeNull(); // Atlantic
    expect(findCountryAt(170, 65)?.code).toBe('RU'); // across the antimeridian
    expect(findCountryAt(Number.NaN, 0)).toBeNull();
  });
});

describe('land dots', () => {
  const dots = computeLandDots();

  it('samples a few thousand dots, each assigned to a country', () => {
    expect(dots.count).toBeGreaterThan(4000);
    expect(dots.count).toBeLessThan(6500);
    const shapes = getWorld().shapes.length;
    for (let i = 0; i < dots.count; i++) {
      const c = dots.country[i] ?? -1;
      expect(c >= 0 && c < shapes).toBe(true);
    }
  });

  it('agrees with d3.geoContains, including Antarctica and the antimeridian', () => {
    const world = getWorld();
    const samples: [number, number][] = [
      [4.4, 50.8],
      [170, 65],
      [-175, 67],
      [0, -88],
      [-30, 30],
      [140, -25],
    ];
    for (const [lon, lat] of samples) {
      const idx = shapeIndexAt(lon, lat);
      const expected = world.shapes.findIndex((s) => geoContains(s.feature, [lon, lat]));
      expect(idx, `${lon},${lat}`).toBe(expected);
    }
  });

  it('spaces dots evenly along a row', () => {
    const row = rowLongitudes(60, DEFAULT_DOT_STEP);
    expect(row.length).toBeGreaterThan(100);
    expect(Math.min(...row)).toBeGreaterThanOrEqual(-180);
    expect(Math.max(...row)).toBeLessThanOrEqual(180);
  });
});

describe('projection maths', () => {
  it('matches d3.geoOrthographic for visible points', () => {
    const vp = { width: 600, height: 400 };
    const view = { lon: 25, lat: 35, zoom: 1.7 };
    const projection = makeProjection(view, vp, geoOrthographic());
    const t = viewTrig(view, vp);
    for (const [lon, lat] of [
      [25, 35],
      [4.4, 50.8],
      [60, 10],
      [-10, 60],
    ] as const) {
      const ours = projectLonLat(t, lon, lat);
      const theirs = projection([lon, lat]);
      expect(ours.z).toBeGreaterThan(0);
      expect(ours.x).toBeCloseTo(theirs?.[0] ?? Number.NaN, 6);
      expect(ours.y).toBeCloseTo(theirs?.[1] ?? Number.NaN, 6);
    }
    expect(projectLonLat(t, 25 + 180, -35).z).toBeLessThan(0);
  });
});

describe('land dot performance', () => {
  it('computes quickly once the world is loaded', () => {
    const t0 = performance.now();
    computeLandDots();
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
