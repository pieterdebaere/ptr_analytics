export const VITAL_METRICS = ['LCP', 'FCP', 'CLS', 'INP', 'TTFB'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];
export type Rating = 'good' | 'needs-improvement' | 'poor';

/** web.dev thresholds: good <= good, poor > poor. */
export const THRESHOLDS: Readonly<Record<VitalMetric, { good: number; poor: number }>> = {
  LCP: { good: 2500, poor: 4000 },
  FCP: { good: 1800, poor: 3000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 800, poor: 1800 },
};

/** Real Experience Score weights (TTFB is not part of RES). */
export const RES_WEIGHTS: ReadonlyArray<readonly [VitalMetric, number]> = [
  ['FCP', 0.15],
  ['LCP', 0.3],
  ['INP', 0.3],
  ['CLS', 0.25],
];

export function rate(metric: VitalMetric, value: number): Rating {
  const t = THRESHOLDS[metric];
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'needs-improvement';
  return 'poor';
}

/**
 * Error function approximation (Abramowitz & Stegun 7.1.26), as used by Lighthouse.
 */
function erf(x: number): number {
  const sign = Math.sign(x);
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
  return sign * (1 - y * Math.exp(-x * x));
}

/**
 * Lighthouse `getLogNormalScore({p10, median}, value)`: the complementary CDF of a
 * log-normal distribution whose 10th percentile is `p10` and median is `median`.
 * Returns 0..1 (value at p10 -> 0.9, value at median -> 0.5).
 */
export function getLogNormalScore({ p10, median }: { p10: number; median: number }, value: number): number {
  if (median <= 0) throw new Error('median must be greater than zero');
  if (p10 <= 0) throw new Error('p10 must be greater than zero');
  if (p10 >= median) throw new Error('p10 must be less than the median');
  if (value <= 0) return 1;

  const INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232;
  const maxOrder = Math.max(Number.MIN_VALUE, value / median);
  const xLogRatio = Math.log(maxOrder);
  const p10Ratio = Math.max(Number.MIN_VALUE, p10 / median);
  const p10LogRatio = -Math.log(p10Ratio);
  const standardizedX = (xLogRatio * INVERSE_ERFC_ONE_FIFTH) / p10LogRatio;
  const complementaryPercentile = (1 - erf(standardizedX)) / 2;

  let score: number;
  if (value <= p10) score = Math.max(0.9, Math.min(1, complementaryPercentile));
  else if (value <= median) score = Math.max(0.5, Math.min(0.89999999999999, complementaryPercentile));
  else score = Math.max(0, Math.min(0.49999999999999, complementaryPercentile));
  return score;
}

/** Metric score 0..1 (unrounded) for a p75 value. */
export function metricScore01(metric: VitalMetric, p75: number): number {
  const t = THRESHOLDS[metric];
  return getLogNormalScore({ p10: t.good, median: t.poor }, p75);
}

/** Metric score 0..100 (rounded). */
export function metricScore(metric: VitalMetric, p75: number): number {
  return Math.min(100, Math.max(0, Math.round(metricScore01(metric, p75) * 100)));
}

/** Real Experience Score (0..100) from per-metric p75s, re-normalised over present metrics. */
export function realExperienceScore(p75s: Partial<Record<VitalMetric, number | null>>): number | null {
  let weighted = 0;
  let total = 0;
  for (const [metric, w] of RES_WEIGHTS) {
    const v = p75s[metric];
    if (v === null || v === undefined) continue;
    weighted += metricScore01(metric, v) * w;
    total += w;
  }
  if (total === 0) return null;
  return Math.min(100, Math.max(0, Math.round((weighted / total) * 100)));
}

/** Nearest-rank percentile index (0-based) for n sorted values. */
export function nearestRankIndex(n: number, p = 0.75): number {
  return Math.max(0, Math.ceil(p * n) - 1);
}
