// Types for the PTR Analytics dashboard API (docs/SPEC.md sections 4.7 and 6).
// All string values coming from analytics data are untrusted.

/**
 * admin = operator (all sites, user management), viewer = read-only access to all
 * sites, member = self-service (hosted mode) account that only sees its own sites.
 */
export type Role = 'admin' | 'viewer' | 'member';
export const ROLES: readonly Role[] = ['admin', 'viewer', 'member'];

export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: number;
  /** Hosted mode: false until the sign-up verification link was used. */
  emailVerified?: boolean;
}

/** `GET /api/public-config` (no auth) — hosted ("cloud") mode switches. */
export interface PublicConfig {
  signupEnabled: boolean;
  billingEnabled: boolean;
  freeSites: number;
  pricePerSiteCents: number;
  /** ISO 4217, lower case (e.g. "eur") */
  currency: string;
  termsUrl: string | null;
  privacyUrl: string | null;
  /** max sites per member when billing is disabled */
  memberSiteLimit?: number;
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
  /** Hosted mode: beyond the member's allowance -> events are dropped. */
  suspended?: boolean;
  /** Only sent to admins: owning member, null = operator site. */
  ownerId?: number | null;
}

/* ---------- Billing (hosted mode) ---------- */

export const BILLING_STATUSES = ['none', 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export interface Billing {
  enabled: boolean;
  freeSites: number;
  pricePerSiteCents: number;
  currency: string;
  sitesUsed: number;
  sitesAllowed: number;
  paidSites: number;
  status: BillingStatus;
  hasCustomer: boolean;
  /** the subscription ends at the end of the current period (quantity set to 0 / cancelled in the portal) */
  cancelAtPeriodEnd?: boolean;
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

/* ---------- Live map (globe) ---------- */

export interface LiveCountry {
  /** ISO 3166-1 alpha-2 or null (unknown) — untrusted */
  country: string | null;
  visitors: number;
}

export interface LiveRecentPageview {
  ts: number;
  country: string | null;
  /** untrusted */
  path: string;
}

/** `GET /api/sites/:id/stats/live` (last 5 minutes, never cached) */
export interface SiteLiveResponse {
  visitors: number;
  countries: LiveCountry[];
  /** newest first, max 50 */
  recent: LiveRecentPageview[];
}

/** `GET /api/live` — aggregated over all sites the user can access */
export interface LiveOverviewResponse {
  visitors: number;
  countries: LiveCountry[];
  /** only sites with visitors in the last 5 minutes, sorted desc */
  sites: Array<{ id: string; name: string; visitors: number }>;
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
  /** machine readable reason, e.g. "upgrade_required" (402) */
  code?: string;
}
