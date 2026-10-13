// Pure helpers for the hand-written SVG charts.

/** Rounds `x` up to a "nice" number (1, 2, 2.5, 5 x 10^k). */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const f = rough / base;
  let nice: number;
  if (f <= 1) nice = 1;
  else if (f <= 2) nice = 2;
  else if (f <= 2.5) nice = 2.5;
  else if (f <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/**
 * Y-axis ticks from 0 up to a nice maximum >= `max`, roughly `count` intervals.
 * `integer` forces integer steps (counts can't be fractional).
 */
export function niceTicks(max: number, count = 4, integer = true): number[] {
  if (!Number.isFinite(max) || max <= 0) return integer ? [0, 1] : [0, 1];
  let step = niceStep(max / count);
  if (integer && step < 1) step = 1;
  if (integer && !Number.isInteger(step)) step = Math.ceil(step);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(roundTo(v, step));
  return ticks;
}

function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(decimals));
}

/** Linear scale mapping [d0, d1] -> [r0, r1]. Degenerate domains map to r0. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => r0;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/**
 * Indices of points that get an x-axis label: at most `maxLabels`, evenly
 * spaced, always including the first point.
 */
export function labelIndices(n: number, maxLabels: number): number[] {
  if (n <= 0 || maxLabels <= 0) return [];
  if (n <= maxLabels) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / maxLabels);
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

/** X position of point `i` of `n` within [left, right]. */
export function pointX(i: number, n: number, left: number, right: number): number {
  if (n <= 1) return (left + right) / 2;
  return left + (i / (n - 1)) * (right - left);
}

/** Nearest point index for pixel `x` (inverse of pointX), clamped. */
export function nearestIndex(x: number, n: number, left: number, right: number): number {
  if (n <= 1) return 0;
  const t = (x - left) / (right - left);
  return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
}

export interface Pt {
  x: number;
  y: number;
}

/**
 * Splits a series into contiguous segments of non-null values (gaps are not
 * interpolated). Returns arrays of pixel points.
 */
export function segments(
  values: ReadonlyArray<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push({ x: x(i), y: y(v) });
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

const r = (n: number): string => (Math.round(n * 100) / 100).toString();

/** SVG path for a polyline through `pts`. */
export function linePath(pts: readonly Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(p.x)},${r(p.y)}`).join('');
}

/** SVG path for the area under `pts` down to `baseY`. */
export function areaPath(pts: readonly Pt[], baseY: number): string {
  if (pts.length === 0) return '';
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${linePath(pts)}L${r(last.x)},${r(baseY)}L${r(first.x)},${r(baseY)}Z`;
}
