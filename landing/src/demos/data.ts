import { createRandom } from '~/lib/random';

/** Fake, deterministic demo data for the feature charts. */

export interface DayPoint extends Record<string, unknown> {
  date: Date;
  visitors: number;
  pageviews: number;
}

export function visitorSeries(days = 30, seed = 7): DayPoint[] {
  const rand = createRandom(seed);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const t = days - 1 - i;
    const weekday = date.getDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.72 : 1;
    const trend = 300 + t * 7.5;
    const visitors = Math.round((trend + Math.sin(t / 2.8) * 38 + rand() * 60) * weekend);
    const pageviews = Math.round(visitors * (1.9 + rand() * 0.5));
    out.push({ date, visitors, pageviews });
  }
  return out;
}

export function sum(points: readonly DayPoint[], key: 'visitors' | 'pageviews'): number {
  return points.reduce((acc, p) => acc + p[key], 0);
}

export const TOP_PAGES = [
  { name: '/', views: 4821 },
  { name: '/pricing', views: 2310 },
  { name: '/blog', views: 1874 },
  { name: '/docs', views: 1402 },
  { name: '/signup', views: 968 },
  { name: '/about', views: 512 },
] as const;

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalMetric {
  key: string;
  name: string;
  value: string;
  rating: VitalRating;
  /** Share of page loads rated "good", 0–100. */
  goodShare: number;
}

export const VITALS: readonly VitalMetric[] = [
  { key: 'LCP', name: 'Largest Contentful Paint', value: '1.8 s', rating: 'good', goodShare: 91 },
  { key: 'INP', name: 'Interaction to Next Paint', value: '212 ms', rating: 'needs-improvement', goodShare: 78 },
  { key: 'CLS', name: 'Cumulative Layout Shift', value: '0.04', rating: 'good', goodShare: 96 },
  { key: 'FCP', name: 'First Contentful Paint', value: '1.1 s', rating: 'good', goodShare: 93 },
  { key: 'TTFB', name: 'Time to First Byte', value: '0.42 s', rating: 'good', goodShare: 95 },
];

export const REAL_EXPERIENCE_SCORE = 94;

export const DEVICES = [
  { label: 'Desktop', value: 58, maxValue: 100, color: 'var(--brand)' },
  { label: 'Mobile', value: 36, maxValue: 100, color: 'oklch(0.72 0.12 190)' },
  { label: 'Tablet', value: 6, maxValue: 100, color: 'oklch(0.7 0.14 300)' },
];
