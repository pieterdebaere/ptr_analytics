// Number / percentage / duration / date formatting helpers.
import type { Interval } from '../api/types';

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string | undefined, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    nfCache.set(key, f);
  }
  return f;
}

/** 1234 -> "1,234" */
export function formatNumber(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '–';
  return nf(locale, { maximumFractionDigits: 0 }).format(n);
}

/** 1234 -> "1.2K", 999 -> "999", 1_500_000 -> "1.5M" */
export function formatCompact(n: number, locale?: string): string {
  if (!Number.isFinite(n)) return '–';
  if (Math.abs(n) < 1000) return nf(locale, { maximumFractionDigits: Number.isInteger(n) ? 0 : 1 }).format(n);
  return nf(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** 0.4321 -> "43%" (ratio 0..1); null -> "–" */
export function formatPercent(ratio: number | null | undefined, locale?: string, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  return nf(locale, { style: 'percent', maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(ratio);
}

/**
 * Relative change from `previous` to `current` as a ratio (0.25 = +25%).
 * Returns null when there is no meaningful comparison (previous is 0/null).
 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return null;
  return (current - previous) / previous;
}

/** 0.253 -> "+25%", -0.1 -> "−10%", 0 -> "0%"; null -> "" */
export function formatChange(change: number | null, locale?: string): string {
  if (change === null || !Number.isFinite(change)) return '';
  const rounded = Math.round(change * 100);
  if (rounded === 0) return '0%';
  const abs = nf(locale, { maximumFractionDigits: 0 }).format(Math.abs(rounded));
  return `${rounded > 0 ? '+' : '−'}${abs}%`;
}


/**
 * Colour semantics of a change. `lowerIsBetter` inverts the sentiment
 * (bounce rate). Returns 'good' | 'bad' | 'neutral'.
 */
export function changeTone(change: number | null, lowerIsBetter = false): 'good' | 'bad' | 'neutral' {
  if (change === null || !Number.isFinite(change) || Math.round(change * 100) === 0) return 'neutral';
  const up = change > 0;
  return up !== lowerIsBetter ? 'good' : 'bad';
}

/** Milliseconds: < 1000 -> "850 ms", >= 1000 -> "1.23 s". */
export function formatMs(ms: number | null | undefined, locale?: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
  if (Math.abs(ms) >= 1000) {
    return `${nf(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ms / 1000)} s`;
  }
  return `${nf(locale, { maximumFractionDigits: 0 }).format(ms)} ms`;
}

/** Seconds as "1h 2m", "3m 20s", "45s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Formatter for the x-axis label of a time bucket. */
export function axisDateFormat(interval: Interval, locale?: string, timeZone?: string): Intl.DateTimeFormat {
  const base: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  switch (interval) {
    case 'hour':
      return new Intl.DateTimeFormat(locale, { ...base, hour: 'numeric' });
    case 'day':
      return new Intl.DateTimeFormat(locale, { ...base, month: 'short', day: 'numeric' });
    case 'month':
      return new Intl.DateTimeFormat(locale, { ...base, month: 'short', year: '2-digit' });
  }
}

/** Formatter for the tooltip title of a time bucket. */
export function tooltipDateFormat(interval: Interval, locale?: string, timeZone?: string): Intl.DateTimeFormat {
  const base: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  switch (interval) {
    case 'hour':
      return new Intl.DateTimeFormat(locale, { ...base, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    case 'day':
      return new Intl.DateTimeFormat(locale, { ...base, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    case 'month':
      return new Intl.DateTimeFormat(locale, { ...base, month: 'long', year: 'numeric' });
  }
}

export function formatDate(ms: number, locale?: string): string {
  if (!Number.isFinite(ms)) return '–';
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
}
