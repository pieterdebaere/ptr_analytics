import { badRequest } from '../lib/errors.js';
import {
  HOUR,
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  isValidTimeZone,
  localDateOf,
  parseLocalDate,
  startOfLocalDay,
  startOfLocalHour,
  type LocalDate,
} from '../lib/time.js';

export type Interval = 'hour' | 'day' | 'month';
export const PERIODS = ['24h', '7d', '30d', '90d', '12m', 'custom'] as const;
export type Period = (typeof PERIODS)[number];

export interface Bucket {
  start: number;
  end: number;
}

export interface ResolvedRange {
  period: Period;
  tz: string;
  interval: Interval;
  /** inclusive start, ms epoch */
  from: number;
  /** exclusive end, ms epoch */
  to: number;
  buckets: Bucket[];
  previous: { from: number; to: number };
  /** Local calendar dates (inclusive) for export file names. */
  fromDate: LocalDate;
  toDate: LocalDate;
}

const MAX_SPAN_DAYS = 3 * 366;

function hourBuckets(from: number, to: number): Bucket[] {
  const out: Bucket[] = [];
  for (let t = from; t < to; t += HOUR) out.push({ start: t, end: Math.min(t + HOUR, to) });
  return out;
}

function dayBuckets(first: LocalDate, days: number, tz: string): Bucket[] {
  const out: Bucket[] = [];
  let start = startOfLocalDay(first, tz);
  for (let i = 0; i < days; i++) {
    const end = startOfLocalDay(addDays(first, i + 1), tz);
    out.push({ start, end });
    start = end;
  }
  return out;
}

/** Month buckets covering [first, lastExclusive) local dates; the first may be partial. */
function monthBuckets(first: LocalDate, lastExclusive: LocalDate, tz: string): Bucket[] {
  const out: Bucket[] = [];
  let cur = first;
  while (compareDates(cur, lastExclusive) < 0) {
    let next = addMonths(cur, 1);
    if (compareDates(next, lastExclusive) > 0) next = lastExclusive;
    out.push({ start: startOfLocalDay(cur, tz), end: startOfLocalDay(next, tz) });
    cur = next;
  }
  return out;
}

export interface PeriodParams {
  period?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  tz?: string | undefined;
}

export function resolvePeriod(params: PeriodParams, now: number): ResolvedRange {
  const tz = params.tz ?? 'UTC';
  if (tz.length > 64 || !isValidTimeZone(tz)) throw badRequest('invalid tz');
  const period = (params.period ?? '7d') as Period;
  if (!PERIODS.includes(period)) throw badRequest('invalid period');

  const today = localDateOf(now, tz);

  switch (period) {
    case '24h': {
      const currentHour = startOfLocalHour(now, tz);
      const from = currentHour - 23 * HOUR;
      const to = currentHour + HOUR;
      return {
        period,
        tz,
        interval: 'hour',
        from,
        to,
        buckets: hourBuckets(from, to),
        previous: { from: from - 24 * HOUR, to: from },
        fromDate: localDateOf(from, tz),
        toDate: today,
      };
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = Number(period.slice(0, -1));
      const first = addDays(today, -(n - 1));
      const buckets = dayBuckets(first, n, tz);
      const from = startOfLocalDay(first, tz);
      const to = startOfLocalDay(addDays(today, 1), tz);
      return {
        period,
        tz,
        interval: 'day',
        from,
        to,
        buckets,
        previous: { from: startOfLocalDay(addDays(first, -n), tz), to: from },
        fromDate: first,
        toDate: today,
      };
    }
    case '12m': {
      const thisMonth: LocalDate = { y: today.y, m: today.m, d: 1 };
      const first = addMonths(thisMonth, -11);
      const end = addMonths(thisMonth, 1);
      const from = startOfLocalDay(first, tz);
      return {
        period,
        tz,
        interval: 'month',
        from,
        to: startOfLocalDay(end, tz),
        buckets: monthBuckets(first, end, tz),
        previous: { from: startOfLocalDay(addMonths(first, -12), tz), to: from },
        fromDate: first,
        toDate: addDays(end, -1),
      };
    }
    case 'custom': {
      const fromDate = params.from === undefined ? null : parseLocalDate(params.from);
      const toDate = params.to === undefined ? null : parseLocalDate(params.to);
      if (!fromDate || !toDate) throw badRequest('from and to (YYYY-MM-DD) are required for custom periods');
      if (compareDates(fromDate, toDate) > 0) throw badRequest('from must not be after to');
      const span = daysBetween(fromDate, toDate) + 1;
      if (span > MAX_SPAN_DAYS) throw badRequest('custom period must not exceed 3 years');
      const endDate = addDays(toDate, 1);
      const from = startOfLocalDay(fromDate, tz);
      const to = startOfLocalDay(endDate, tz);
      let interval: Interval;
      let buckets: Bucket[];
      if (span <= 2) {
        interval = 'hour';
        buckets = hourBuckets(from, to);
      } else if (span <= 92) {
        interval = 'day';
        buckets = dayBuckets(fromDate, span, tz);
      } else {
        interval = 'month';
        buckets = monthBuckets(fromDate, endDate, tz);
      }
      return {
        period,
        tz,
        interval,
        from,
        to,
        buckets,
        previous: { from: startOfLocalDay(addDays(fromDate, -span), tz), to: from },
        fromDate,
        toDate,
      };
    }
  }
}
