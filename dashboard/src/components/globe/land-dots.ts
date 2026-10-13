// Dot-matrix land: samples a latitude-row grid (roughly equal-area spacing)
// and keeps the points that fall inside a country, remembering which one so
// the dots can be tinted per country. Computed once, lazily and in idle-time
// slices, then cached for the module lifetime.

import type { Position } from 'geojson';
import { getWorld } from './geo';

export interface LandDots {
  count: number;
  /** longitude, radians */
  lambda: Float32Array;
  sinPhi: Float32Array;
  cosPhi: Float32Array;
  /** index into getWorld().shapes */
  country: Int16Array;
}

/** Default spacing between dots in degrees (~5.2k dots on land). */
export const DEFAULT_DOT_STEP = 1.5;

interface IndexedPolygon {
  shape: number;
  /** [west, south, east, north] of the (unwrapped) outer ring */
  bbox: [number, number, number, number];
  /** rings with continuous longitudes (may extend beyond ±180) */
  rings: Position[][];
}

/**
 * Makes ring longitudes continuous across the antimeridian. Rings that wrap
 * all the way around a pole (Antarctica) are closed through that pole, so a
 * plain planar test works for every ring — much faster than d3.geoContains.
 */
export function unwrapRing(ring: Position[]): Position[] {
  const out: Position[] = [];
  let offset = 0;
  let prev: number | null = null;
  let latSum = 0;
  for (const p of ring) {
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    if (prev !== null) {
      const dx = x - prev;
      if (dx > 180) offset -= 360;
      else if (dx < -180) offset += 360;
    }
    prev = x;
    latSum += y;
    out.push([x + offset, y]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && Math.abs((last[0] ?? 0) - (first[0] ?? 0)) >= 359) {
    const pole = latSum < 0 ? -90 : 90;
    out.push([last[0] ?? 0, pole], [first[0] ?? 0, pole], [first[0] ?? 0, first[1] ?? 0]);
  }
  return out;
}

function ringContains(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const xi = pi[0] ?? 0;
    const yi = pi[1] ?? 0;
    const xj = pj[0] ?? 0;
    const yj = pj[1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

let polygonIndex: IndexedPolygon[] | null = null;

function getPolygonIndex(): IndexedPolygon[] {
  if (polygonIndex) return polygonIndex;
  const out: IndexedPolygon[] = [];
  for (const shape of getWorld().shapes) {
    const g = shape.feature.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const raw of polys) {
      const rings = raw.map(unwrapRing);
      const outer = rings[0];
      if (!outer) continue;
      let w = Infinity;
      let s = Infinity;
      let e = -Infinity;
      let n = -Infinity;
      for (const p of outer) {
        const x = p[0] ?? 0;
        const y = p[1] ?? 0;
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
      out.push({ shape: shape.index, bbox: [w, s, e, n], rings });
    }
  }
  polygonIndex = out;
  return out;
}

function containsAt(p: IndexedPolygon, lon: number, lat: number): boolean {
  const [w, s, e, n] = p.bbox;
  if (lat < s || lat > n || lon < w || lon > e) return false;
  const outer = p.rings[0];
  if (!outer || !ringContains(outer, lon, lat)) return false;
  for (let k = 1; k < p.rings.length; k++) {
    const hole = p.rings[k];
    if (hole && ringContains(hole, lon, lat)) return false;
  }
  return true;
}

function containsPoint(p: IndexedPolygon, lon: number, lat: number): boolean {
  if (containsAt(p, lon, lat)) return true;
  // Only rings unwrapped past the antimeridian can match a shifted longitude.
  if (p.bbox[2] > 180 && containsAt(p, lon + 360, lat)) return true;
  if (p.bbox[0] < -180 && containsAt(p, lon - 360, lat)) return true;
  return false;
}

function firstMatch(polys: readonly IndexedPolygon[], lon: number, lat: number): number {
  for (const p of polys) if (containsPoint(p, lon, lat)) return p.shape;
  return -1;
}

/** Shape index of the country at a point, using the fast polygon index (-1 = sea). */
export function shapeIndexAt(lon: number, lat: number): number {
  return firstMatch(getPolygonIndex(), lon, lat);
}

/** Number of latitude rows for a given step. */
export function rowCount(step: number): number {
  return Math.floor(180 / step);
}

/** Longitudes sampled on one latitude row (spacing widens towards the equator, constant on the sphere). */
export function rowLongitudes(row: number, step: number): number[] {
  const lat = -90 + step * (row + 0.5);
  const c = Math.cos((lat * Math.PI) / 180);
  const n = Math.max(1, Math.round((360 * c) / step));
  const lonStep = 360 / n;
  const offset = row % 2 === 0 ? 0 : lonStep / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(-180 + offset + lonStep * (i + 0.5));
  return out;
}

class DotBuffer {
  lambda: number[] = [];
  sinPhi: number[] = [];
  cosPhi: number[] = [];
  country: number[] = [];

  sampleRow(row: number, step: number): void {
    const lat = -90 + step * (row + 0.5);
    const phi = (lat * Math.PI) / 180;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    // Only polygons spanning this latitude can contain dots of the row.
    const candidates = getPolygonIndex().filter((p) => lat >= p.bbox[1] && lat <= p.bbox[3]);
    if (candidates.length === 0) return;
    for (const lon of rowLongitudes(row, step)) {
      const idx = firstMatch(candidates, lon, lat);
      if (idx < 0) continue;
      this.lambda.push((lon * Math.PI) / 180);
      this.sinPhi.push(sp);
      this.cosPhi.push(cp);
      this.country.push(idx);
    }
  }

  pack(): LandDots {
    return {
      count: this.lambda.length,
      lambda: Float32Array.from(this.lambda),
      sinPhi: Float32Array.from(this.sinPhi),
      cosPhi: Float32Array.from(this.cosPhi),
      country: Int16Array.from(this.country),
    };
  }
}

/** Synchronous computation (tests / workers). ~50–100 ms for the default step. */
export function computeLandDots(step = DEFAULT_DOT_STEP): LandDots {
  const buf = new DotBuffer();
  const rows = rowCount(step);
  for (let r = 0; r < rows; r++) buf.sampleRow(r, step);
  return buf.pack();
}

let cached: LandDots | null = null;
let pending: Promise<LandDots> | null = null;

/** Already-computed dots, or null. */
export function peekLandDots(): LandDots | null {
  return cached;
}

type SliceScheduler = (cb: () => void) => void;

// Macrotask slices (not requestIdleCallback: idle periods are rare while the
// globe animates, which would delay the land by seconds).
const defaultScheduler: SliceScheduler = (cb) => {
  setTimeout(cb, 0);
};

/**
 * Computes the dots in small time slices so the main thread
 * never blocks for more than a few milliseconds. Cached and de-duplicated.
 */
export function loadLandDots(sliceMs = 8, schedule: SliceScheduler = defaultScheduler): Promise<LandDots> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = new Promise<LandDots>((resolve, reject) => {
    const step = DEFAULT_DOT_STEP;
    const rows = rowCount(step);
    const buf = new DotBuffer();
    let row = 0;
    const work = () => {
      try {
        const start = performance.now();
        // The first slice also builds the world + polygon index.
        while (row < rows && performance.now() - start < sliceMs) buf.sampleRow(row++, step);
        if (row < rows) {
          schedule(work);
          return;
        }
        cached = buf.pack();
        resolve(cached);
      } catch (err) {
        pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    schedule(work);
  });
  return pending;
}
