import type { Rating, VitalMetric } from '../api/types';
import { formatMs } from './format';

/** web.dev thresholds: good <= good, poor > poor. */
export const THRESHOLDS: Record<VitalMetric, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  FCP: { good: 1800, poor: 3000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 800, poor: 1800 },
};

export const METRIC_INFO: Record<VitalMetric, { name: string; description: string }> = {
  LCP: {
    name: 'Largest Contentful Paint',
    description: 'Time until the largest image or text block in the viewport is rendered. Measures perceived loading speed.',
  },
  INP: {
    name: 'Interaction to Next Paint',
    description: 'Latency of clicks, taps and key presses until the page visibly responds. Measures responsiveness.',
  },
  CLS: {
    name: 'Cumulative Layout Shift',
    description: 'How much visible content unexpectedly moves around while the page is open. Measures visual stability.',
  },
  FCP: {
    name: 'First Contentful Paint',
    description: 'Time until the first text or image is painted on the screen.',
  },
  TTFB: {
    name: 'Time to First Byte',
    description: 'Time between the navigation start and the first byte of the response. Measures server and network latency.',
  },
};

export const RES_DESCRIPTION =
  'The Real Experience Score is a weighted average of the LCP (30%), INP (30%), CLS (25%) and FCP (15%) scores, based on the 75th percentile of real visits.';

export function rateValue(metric: VitalMetric, value: number | null | undefined): Rating | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const t = THRESHOLDS[metric];
  if (value <= t.good) return 'good';
  if (value > t.poor) return 'poor';
  return 'needs-improvement';
}

/** Rating of a 0..100 Real Experience Score. */
export function rateScore(score: number | null | undefined): Rating | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score >= 90) return 'good';
  if (score >= 50) return 'needs-improvement';
  return 'poor';
}

/** p75 display value: CLS with 3 decimals, everything else as ms / s. */
export function formatVital(metric: VitalMetric, value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  if (metric === 'CLS') {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
  }
  return formatMs(value, locale);
}

export const RATING_LABELS: Record<Rating, string> = {
  good: 'Good',
  'needs-improvement': 'Needs improvement',
  poor: 'Poor',
};

export function isRating(v: unknown): v is Rating {
  return v === 'good' || v === 'needs-improvement' || v === 'poor';
}
