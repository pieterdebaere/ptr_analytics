/**
 * Time-zone aware calendar helpers built on Intl (no dependencies).
 * All instants are ms since epoch; "local" dates are wall-clock dates in a given IANA zone.
 */

export interface LocalDate {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

interface LocalParts extends LocalDate {
  h: number;
  mi: number;
  s: number;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 1000;

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** Is `tz` a valid IANA time zone accepted by Intl? */
export function isValidTimeZone(tz: string): boolean {
  if (!TZ_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localParts(ts: number, tz: string): LocalParts {
  const out: LocalParts = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
  let bc = false;
  for (const p of formatter(tz).formatToParts(new Date(ts))) {
    switch (p.type) {
      case 'year':
        out.y = Number(p.value);
        break;
      case 'month':
        out.m = Number(p.value);
        break;
      case 'day':
        out.d = Number(p.value);
        break;
      case 'hour':
        out.h = Number(p.value);
        break;
      case 'minute':
        out.mi = Number(p.value);
        break;
      case 'second':
        out.s = Number(p.value);
        break;
      case 'era':
        bc = p.value === 'BC' || p.value === 'B';
        break;
    }
  }
  if (bc) out.y = 1 - out.y;
  return out;
}

/** Offset (local - UTC) in ms at instant ts. */
export function tzOffset(ts: number, tz: string): number {
  const secFloor = Math.floor(ts / 1000) * 1000;
  const p = localParts(secFloor, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - secFloor;
}

export function localDateOf(ts: number, tz: string): LocalDate {
  const p = localParts(ts, tz);
  return { y: p.y, m: p.m, d: p.d };
}

/**
 * The instant at which local wall-clock time `y-m-d h:00` begins in `tz`.
 * Ambiguous times (DST fall-back) resolve to the earlier instant; nonexistent times
 * (DST spring-forward gap) resolve to the instant the gap ends.
 */
export function zonedStart(y: number, m: number, d: number, h: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, h, 0, 0);
  const offsets = new Set([tzOffset(naive - 14 * HOUR, tz), tzOffset(naive, tz), tzOffset(naive + 14 * HOUR, tz)]);
  const candidates: number[] = [];
  for (const o of offsets) candidates.push(naive - o);
  const valid = candidates.filter((t) => {
    const p = localParts(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) === naive;
  });
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: the wall-clock time is skipped; the earliest valid instant after it is the
  // transition itself, which is the largest candidate (computed with the pre-transition offset).
  return Math.max(...candidates);
}

export function startOfLocalDay(date: LocalDate, tz: string): number {
  return zonedStart(date.y, date.m, date.d, 0, tz);
}

/** Calendar arithmetic on local dates (independent of time zones). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1 + months, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: 1 };
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY);
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}

/** Parse strict `YYYY-MM-DD` (valid calendar date) or return null. */
export function parseLocalDate(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function formatLocalDate(date: LocalDate): string {
  return `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
}

/** Start of the local hour containing `ts`. Exact for whole/half-hour offsets. */
export function startOfLocalHour(ts: number, tz: string): number {
  const off = tzOffset(ts, tz);
  const local = ts + off;
  return local - (((local % HOUR) + HOUR) % HOUR) - off;
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export { HOUR, DAY };
