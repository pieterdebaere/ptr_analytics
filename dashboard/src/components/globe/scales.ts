// Pure scales and small helpers (value -> intensity / radius, zoom clamping,
// deterministic jitter).

export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 6;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamps a zoom factor into [MIN_ZOOM, MAX_ZOOM]; non-finite values fall back to 1. */
export function clampZoom(z: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(z)) return clamp(1, min, max);
  return clamp(z, min, max);
}

/**
 * Log scale normalised to the maximum: 0 for no traffic, 1 for the busiest
 * country. Analytics data is heavy-tailed, so a linear scale would leave all
 * but the top country invisible.
 */
export function createIntensityScale(values: Iterable<number>): (value: number) => number {
  let max = 0;
  for (const v of values) if (Number.isFinite(v) && v > max) max = v;
  const denom = Math.log1p(max);
  return (value: number) => {
    if (!(denom > 0) || !Number.isFinite(value) || value <= 0) return 0;
    return clamp(Math.log1p(value) / denom, 0, 1);
  };
}

/** Marker radius in CSS pixels for a share of the maximum value in [0, 1] (area ∝ value). */
export function markerRadius(intensity: number, min = 1.75, max = 5.5): number {
  const t = clamp(Number.isFinite(intensity) ? intensity : 0, 0, 1);
  return min + (max - min) * Math.sqrt(t);
}

/** Quantises an intensity into one of `buckets` levels (1..buckets), 0 stays 0. */
export function intensityBucket(intensity: number, buckets: number): number {
  if (!(intensity > 0)) return 0;
  return clamp(Math.ceil(intensity * buckets), 1, buckets);
}

/** 32-bit FNV-1a hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic offset (degrees) inside a disc of `radius` degrees, so several
 * pings in the same country do not stack on the exact same pixel.
 */
export function jitterOffset(id: string, radius: number): [dLon: number, dLat: number] {
  if (!(radius > 0)) return [0, 0];
  const h = hashString(id);
  const a = ((h & 0xffff) / 0xffff) * Math.PI * 2;
  const r = Math.sqrt(((h >>> 16) & 0xffff) / 0xffff) * radius;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Wraps a longitude into [-180, 180). */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
