// Period / filter state <-> URL query string, and API query builders.
import {
  FILTER_KEYS,
  PERIODS,
  type FilterKey,
  type Filters,
  type Period,
  type PeriodSelection,
  type StatsQuery,
  type VitalDevice,
  type VitalsQuery,
} from '../api/types';

export const DEFAULT_PERIOD: Period = '7d';
export const MAX_FILTER_LENGTH = 1024;
/** Custom ranges may span at most 3 years (server limit). */
export const MAX_CUSTOM_SPAN_DAYS = 3 * 366;

export const PERIOD_LABELS: Record<Period, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 3 months',
  '12m': 'Last 12 months',
  custom: 'Custom range',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

export function isFilterKey(value: unknown): value is FilterKey {
  return typeof value === 'string' && (FILTER_KEYS as readonly string[]).includes(value);
}

/** Strict YYYY-MM-DD validation (real calendar date). */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Number of days between two YYYY-MM-DD dates (to - from). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Returns an error message for an invalid custom range, or null when valid. */
export function validateCustomRange(from: string | undefined, to: string | undefined): string | null {
  if (!isValidDate(from) || !isValidDate(to)) return 'Pick a start and end date.';
  const span = daysBetween(from, to);
  if (span < 0) return 'The start date must be before the end date.';
  if (span > MAX_CUSTOM_SPAN_DAYS) return 'The range can span at most 3 years.';
  return null;
}

/** Reads the period selection from the URL. Invalid input falls back to the default. */
export function parsePeriod(params: URLSearchParams): PeriodSelection {
  const raw = params.get('period');
  if (!isPeriod(raw)) return { period: DEFAULT_PERIOD };
  if (raw === 'custom') {
    const from = params.get('from') ?? undefined;
    const to = params.get('to') ?? undefined;
    if (validateCustomRange(from, to) !== null) return { period: DEFAULT_PERIOD };
    return { period: 'custom', from, to };
  }
  return { period: raw };
}

/** Reads the dimension filters from the URL (allow-listed keys only). */
export function parseFilters(params: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value !== null && value.length <= MAX_FILTER_LENGTH) filters[key] = value;
  }
  return filters;
}

/** Returns a copy of `params` with the period selection applied. */
export function withPeriod(params: URLSearchParams, sel: PeriodSelection): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('period');
  next.delete('from');
  next.delete('to');
  if (sel.period !== DEFAULT_PERIOD) next.set('period', sel.period);
  if (sel.period === 'custom' && sel.from && sel.to) {
    next.set('from', sel.from);
    next.set('to', sel.to);
  }
  return next;
}

/** Returns a copy of `params` with one filter set (string) or removed (null). */
export function withFilter(
  params: URLSearchParams,
  key: FilterKey,
  value: string | null,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === null) next.delete(key);
  else next.set(key, value.slice(0, MAX_FILTER_LENGTH));
  return next;
}

/** Only the period part of the query string (for links between pages). */
export function periodSearch(params: URLSearchParams): string {
  const sel = parsePeriod(params);
  const s = withPeriod(new URLSearchParams(), sel).toString();
  return s ? `?${s}` : '';
}

export function filterCount(filters: Filters): number {
  return Object.keys(filters).length;
}

function appendPeriod(out: URLSearchParams, sel: PeriodSelection): void {
  out.set('period', sel.period);
  if (sel.period === 'custom') {
    if (sel.from) out.set('from', sel.from);
    if (sel.to) out.set('to', sel.to);
  }
}

/** Builds the query parameters for /stats/* and /export requests. */
export function statsParams(
  q: StatsQuery,
  extra?: Record<string, string | number | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  appendPeriod(out, q);
  out.set('tz', q.tz);
  if (q.filters) {
    for (const key of FILTER_KEYS) {
      const v = q.filters[key];
      if (v !== undefined) out.set(key, v);
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) out.set(k, String(v));
  }
  return out;
}

/** Builds the query parameters for /vitals/* requests. */
export function vitalsParams(
  q: VitalsQuery,
  extra?: Record<string, string | number | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  appendPeriod(out, q);
  out.set('tz', q.tz);
  if (q.device) out.set('device', q.device);
  if (q.path !== undefined) out.set('path', q.path);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) out.set(k, String(v));
  }
  return out;
}

const SITE_ID_RE = /^[a-z0-9]{12}$/;
export function isSiteId(value: unknown): value is string {
  return typeof value === 'string' && SITE_ID_RE.test(value);
}

/** Same-origin URL of the CSV export for the current period + filters. */
export function exportUrl(siteId: string, q: StatsQuery): string {
  return `/api/sites/${encodeURIComponent(siteId)}/export?${statsParams(q).toString()}`;
}

export function parseVitalDevice(value: string | null): VitalDevice | undefined {
  return value === 'desktop' || value === 'mobile' || value === 'tablet' ? value : undefined;
}

/** The browser's IANA time zone (sent as `tz` with every stats request). */
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.length <= 64) return tz;
  } catch {
    /* ignore */
  }
  return 'UTC';
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayIn(tz: string, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Shift a YYYY-MM-DD date by `days`. */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
