// World geometry: country features from world-atlas (bundled statically),
// alpha-2 lookup, cached centroids and point-in-country hit testing.

import { geoArea, geoBounds, geoCentroid, geoContains } from 'd3-geo';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import worldAtlas from 'world-atlas/countries-110m.json';
import { alpha2ForFeature, normalizeAlpha2 } from './country-codes';
import { SMALL_TERRITORY_CENTROIDS } from './small-territories';

export type LonLat = [lon: number, lat: number];

export type CountryFeature = Feature<Polygon | MultiPolygon, { name: string }>;

export interface CountryShape {
  /** index in `World.shapes` */
  index: number;
  /** ISO alpha-2 (null only if the atlas grows a feature we cannot map) */
  code: string | null;
  /** Natural Earth short name (fallback label) */
  name: string;
  feature: CountryFeature;
  /** d3.geoBounds: [[west, south], [east, north]]; west > east when crossing the antimeridian */
  bounds: [[number, number], [number, number]];
}

export interface World {
  shapes: CountryShape[];
  byCode: ReadonlyMap<string, readonly CountryShape[]>;
}

type CountriesTopology = Topology<{
  countries: GeometryCollection<{ name: string }>;
  land: GeometryCollection;
}>;

let world: World | null = null;

/** Lazily converts the TopoJSON once and caches it for the module lifetime. */
export function getWorld(): World {
  if (world) return world;
  const topo = worldAtlas as unknown as CountriesTopology;
  const fc = feature(topo, topo.objects.countries);
  const shapes: CountryShape[] = [];
  const byCode = new Map<string, CountryShape[]>();
  for (const f of fc.features) {
    const geom = f.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    const name = f.properties?.name ?? '';
    const shape: CountryShape = {
      index: shapes.length,
      code: alpha2ForFeature(f.id, name),
      name,
      feature: f as CountryFeature,
      bounds: geoBounds(f as CountryFeature),
    };
    shapes.push(shape);
    if (shape.code) {
      const list = byCode.get(shape.code);
      // Features with an ISO id come first, so the primary shape (e.g. Cyprus
      // rather than N. Cyprus) is always byCode.get(code)[0].
      if (!list) byCode.set(shape.code, [shape]);
      else if (f.id !== undefined) list.unshift(shape);
      else list.push(shape);
    }
  }
  world = { shapes, byCode };
  return world;
}

/** Shapes for an alpha-2 code (empty for unknown / invalid codes). */
export function shapesForCode(code: unknown): readonly CountryShape[] {
  const c = normalizeAlpha2(code);
  if (!c) return [];
  return getWorld().byCode.get(c) ?? [];
}

/**
 * The polygon with the largest spherical area — so overseas territories
 * (French Guiana, Alaska, Svalbard, ...) do not drag the centroid into the sea.
 */
export function largestPolygon(f: CountryFeature): Polygon {
  const g = f.geometry;
  if (g.type === 'Polygon') return g;
  let best: Position[][] | undefined;
  let bestArea = -1;
  for (const coords of g.coordinates) {
    const area = geoArea({ type: 'Polygon', coordinates: coords });
    if (area > bestArea) {
      bestArea = area;
      best = coords;
    }
  }
  return { type: 'Polygon', coordinates: best ?? [] };
}

interface CountryAnchor {
  centroid: LonLat;
  /** angular radius (degrees) used to spread pings inside the country */
  spread: number;
}

const anchorCache = new Map<string, CountryAnchor | null>();

function countryAnchor(code: unknown): CountryAnchor | null {
  const c = normalizeAlpha2(code);
  if (!c) return null;
  const cached = anchorCache.get(c);
  if (cached !== undefined) return cached;
  const primary = shapesForCode(c)[0];
  let anchor: CountryAnchor | null = null;
  if (primary) {
    const poly = largestPolygon(primary.feature);
    const [lon, lat] = geoCentroid(poly);
    // sqrt(steradians) ~ angular size; keep pings well inside small countries
    const spread = Math.min(2.5, Math.max(0.15, Math.sqrt(geoArea(poly)) * (180 / Math.PI) * 0.22));
    if (Number.isFinite(lon) && Number.isFinite(lat)) anchor = { centroid: [lon, lat], spread };
  } else {
    const small = SMALL_TERRITORY_CENTROIDS[c];
    if (small) anchor = { centroid: small, spread: 0.12 };
  }
  anchorCache.set(c, anchor);
  return anchor;
}

/** Cached centroid of the country's main landmass, or null for unknown codes. */
export function countryCentroid(code: unknown): LonLat | null {
  return countryAnchor(code)?.centroid ?? null;
}

/** Angular radius (degrees) for jittering markers inside the country. */
export function countrySpread(code: unknown): number {
  return countryAnchor(code)?.spread ?? 0;
}

/** Number of cached centroid lookups (for tests). */
export function centroidCacheSize(): number {
  return anchorCache.size;
}

function inBounds(b: CountryShape['bounds'], lon: number, lat: number): boolean {
  const [[w, s], [e, n]] = b;
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

/** Country containing the point (bounding-box prefilter + d3.geoContains). */
export function findCountryAt(lon: number, lat: number): CountryShape | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const point: LonLat = [lon, lat];
  for (const s of getWorld().shapes) {
    if (inBounds(s.bounds, lon, lat) && geoContains(s.feature, point)) return s;
  }
  return null;
}
