// Types for the PTR Analytics dashboard API (docs/SPEC.md section 4.7).
// All string values coming from analytics data are untrusted.

export type Role = 'admin' | 'viewer';

export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: number;
}

export interface AppConfig {
  publicUrl: string | null;
  version: string;
  geoip: boolean;
}

export interface Site {
  id: string;
  name: string;
  domains: string[];
  createdAt: number;
}

/* ---------- Stats query parameters ---------- */

export const PERIODS = ['24h', '7d', '30d', '90d', '12m', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export const FILTER_KEYS = [
  'path',
  'hostname',
  'referrer',
  'country',
  'device',
  'browser',
  'os',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'event',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/** Exact-match filters. An empty string means "IS NULL" (e.g. direct traffic). */
export type Filters = Partial<Record<FilterKey, string>>;

export interface PeriodSelection {
  period: Period;
  /** YYYY-MM-DD, only for period=custom */
  from?: string;
  /** YYYY-MM-DD, only for period=custom */
  to?: string;
}

export interface StatsQuery extends PeriodSelection {
  tz: string;
  filters?: Filters;
}

export type Interval = 'hour' | 'day' | 'month';

/* ---------- Stats responses ---------- */

export interface OverviewSite {
  id: string;
  name: string;
  domains: string[];
  visitors: number;
  pageviews: number;
  previousVisitors: number;
  /** visitors per bucket */
  series: number[];
}

export interface OverviewResponse {
  sites: OverviewSite[];
}

export interface SummaryValues {
  visitors: number;
  pageviews: number;
  /** 0..1 or null when there are no sessions */
  bounceRate: number | null;
  events: number;
}

export interface SummaryResponse extends SummaryValues {
  previous: SummaryValues;
}

export interface TimeseriesPoint {
  /** bucket start, ms epoch */
  t: number;
  visitors: number;
  pageviews: number;
  /** Not part of the spec (yet); charted when the server provides it. */
  bounceRate?: number | null;
}

export interface TimeseriesResponse {
  interval: Interval;
  points: TimeseriesPoint[];
}

export const BREAKDOWN_DIMENSIONS = FILTER_KEYS;
export type BreakdownDimension = FilterKey;

export interface BreakdownRow {
  value: string | null;
  visitors: number;
  /** pageviews, or number of events for dimension=event */
  count: number;
}

export interface BreakdownResponse {
  dimension: BreakdownDimension;
  rows: BreakdownRow[];
}

export interface EventPropRow {
  key: string;
  value: string | null;
  visitors: number;
  count: number;
}

export interface EventPropsResponse {
  rows: EventPropRow[];
}

export interface RealtimeResponse {
  visitors: number;
}

/* ---------- Speed Insights ---------- */

export const VITAL_METRICS = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];
export type VitalTimeseriesMetric = VitalMetric | 'RES';

export type Rating = 'good' | 'needs-improvement' | 'poor';

export type VitalDevice = 'desktop' | 'mobile' | 'tablet';

export interface VitalMetricSummary {
  p75: number | null;
  count: number;
  score: number | null;
  rating: Rating | null;
}

export interface VitalsSummaryResponse {
  score: number | null;
  metrics: Record<VitalMetric, VitalMetricSummary>;
}

export interface VitalsPoint {
  t: number;
  /** p75, or score for RES */
  value: number | null;
  count: number;
}

export interface VitalsTimeseriesResponse {
  interval: Interval;
  points: VitalsPoint[];
}

export const VITAL_DIMENSIONS = ['path', 'hostname', 'country', 'device', 'browser', 'os'] as const;
export type VitalDimension = (typeof VITAL_DIMENSIONS)[number];

export interface VitalsBreakdownRow {
  value: string | null;
  p75: number | null;
  count: number;
  rating: Rating | null;
}

export interface VitalsBreakdownResponse {
  rows: VitalsBreakdownRow[];
}

export interface VitalsQuery extends PeriodSelection {
  tz: string;
  device?: VitalDevice;
  path?: string;
}

export interface ApiErrorBody {
  error: string;
}
