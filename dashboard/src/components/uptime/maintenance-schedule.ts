// Maintenance editor state, validation and a client-side preview of the next windows
// (all strategies, IANA time zones via Intl). The server stays authoritative
// (`nextWindow` in the API); this only powers the live preview while editing.
import { ApiError } from '@/api/client';
import type { Maintenance, MaintenanceInput, MaintenanceStrategy } from '@/api/uptime';

export interface MaintenanceDraft {
  title: string;
  description: string;
  active: boolean;
  strategy: MaintenanceStrategy;
  tz: string;
  /** single: "YYYY-MM-DDTHH:mm"; recurring: optional "YYYY-MM-DD" (effective from; required for interval) */
  startLocal: string;
  /** single: "YYYY-MM-DDTHH:mm"; recurring: optional "YYYY-MM-DD" (effective until, inclusive) */
  endLocal: string;
  timeStart: string;
  timeEnd: string;
  weekdays: number[];
  daysOfMonth: Array<number | 'L'>;
  intervalDays: number | undefined;
  cron: string;
  durationMin: number | undefined;
  monitorUids: string[];
  statusPageUids: string[];
}

export interface Window {
  start: number;
  end: number;
}

const MIN = 60_000;
const DAY = 86_400_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/* ---------------- time zones ---------------- */

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list && list.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    /* older engines */
  }
  return ['UTC', 'Europe/London', 'Europe/Brussels', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney'];
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  dow: number;
}

export function localParts(ts: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of partsFmt(tz).formatToParts(ts)) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), dow: WEEKDAY_INDEX[p.weekday ?? 'Sun'] ?? 0 };
}

/** Offset of `tz` from UTC at instant `ts`, in ms. */
function tzOffset(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(ts / MIN) * MIN;
}

/** UTC instant of a wall-clock time in `tz` (DST gaps resolve forward, overlaps to the first). */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const o1 = tzOffset(guess - 0, tz);
  let ts = guess - o1;
  const o2 = tzOffset(ts, tz);
  if (o2 !== o1) {
    const alt = guess - o2;
    const p = localParts(alt, tz);
    ts = p.h === h && p.min === min ? alt : Math.max(ts, alt);
  }
  return ts;
}

function parseTime(s: string): { h: number; min: number } | null {
  const m = TIME_RE.exec(s);
  return m ? { h: Number(m[1]), min: Number(m[2]) } : null;
}

function parseDate(s: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? { y, m: mo, d } : null;
}

function parseDateTime(s: string): { y: number; m: number; d: number; h: number; min: number } | null {
  const m = DATETIME_RE.exec(s);
  if (!m) return null;
  const date = parseDate(`${m[1]}-${m[2]}-${m[3]}`);
  return date ? { ...date, h: Number(m[4]), min: Number(m[5]) } : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toLocalDateTime(ts: number, tz: string): string {
  const p = localParts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

export function toLocalDate(ts: number, tz: string): string {
  const p = localParts(ts, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/* ---------------- cron ---------------- */

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  lastDay: boolean;
  months: Set<number>;
  weekdays: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseField(src: string, lo: number, hi: number, names?: string[], allowL = false): { set: Set<number>; last: boolean; any: boolean } | string {
  const set = new Set<number>();
  let last = false;
  const any = src === '*' || src === '?';
  const val = (t: string): number => {
    const u = t.toUpperCase();
    if (names) {
      const i = names.indexOf(u);
      if (i >= 0) return i + (lo === 1 ? 1 : 0);
    }
    return /^\d{1,2}$/.test(t) ? Number(t) : NaN;
  };
  for (const part of src.split(',')) {
    if (allowL && part.toUpperCase() === 'L') {
      last = true;
      continue;
    }
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : /^\d{1,3}$/.test(stepStr) ? Number(stepStr) : NaN;
    if (!range || !Number.isFinite(step) || step < 1) return `invalid “${part}”`;
    let a: number;
    let b: number;
    if (range === '*' || range === '?') {
      a = lo;
      b = hi;
    } else if (range.includes('-')) {
      const [x, y] = range.split('-');
      a = val(x ?? '');
      b = val(y ?? '');
    } else {
      a = val(range);
      b = stepStr === undefined ? a : hi;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < lo || b > hi || a > b) return `out of range “${part}”`;
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, last, any };
}

/** Parses a 5-field cron expression (minute hour day-of-month month day-of-week; `L` = last day). */
export function parseCron(expr: string): CronSpec | string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || expr.length > 120) return 'Use 5 fields: minute hour day month weekday.';
  const mi = parseField(fields[0]!, 0, 59);
  const ho = parseField(fields[1]!, 0, 23);
  const dm = parseField(fields[2]!, 1, 31, undefined, true);
  const mo = parseField(fields[3]!, 1, 12, MONTH_NAMES);
  const dw = parseField(fields[4]!, 0, 7, DOW_NAMES);
  if (typeof dw !== 'string' && dw.set.delete(7)) dw.set.add(0); // 7 = Sunday
  const labels = ['Minute', 'Hour', 'Day of month', 'Month', 'Weekday'];
  const all = [mi, ho, dm, mo, dw];
  for (let i = 0; i < all.length; i++) if (typeof all[i] === 'string') return `${labels[i]}: ${all[i] as string}`;
  const [m1, h1, d1, mo1, w1] = all as Array<{ set: Set<number>; last: boolean; any: boolean }>;
  return {
    minutes: m1!.set,
    hours: h1!.set,
    days: d1!.set,
    lastDay: d1!.last,
    months: mo1!.set,
    weekdays: w1!.set,
    domRestricted: !d1!.any,
    dowRestricted: !w1!.any,
  };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function cronDayMatches(c: CronSpec, y: number, m: number, d: number, dow: number): boolean {
  if (!c.months.has(m)) return false;
  const domOk = c.days.has(d) || (c.lastDay && d === daysInMonth(y, m));
  const dowOk = c.weekdays.has(dow);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk; // standard cron OR semantics
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/* ---------------- windows ---------------- */

/** Duration of a daily window from "HH:mm" times (crossing midnight adds a day), in ms. */
export function dailyDuration(start: string, end: string): number | null {
  const a = parseTime(start);
  const b = parseTime(end);
  if (!a || !b) return null;
  let diff = (b.h * 60 + b.min - (a.h * 60 + a.min)) * MIN;
  if (diff <= 0) diff += DAY;
  return diff;
}

/** Calendar days (local, as UTC midnight stamps) from `from` for `n` days. */
function* localDays(fromTs: number, tz: string, n: number): Generator<{ y: number; m: number; d: number; dow: number }> {
  const p = localParts(fromTs, tz);
  const base = Date.UTC(p.y, p.m - 1, p.d);
  for (let i = 0; i < n; i++) {
    const dt = new Date(base + i * DAY);
    yield { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
  }
}

function dayNumber(y: number, m: number, d: number): number {
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

/** Effective [from, until) bounds of a recurring draft (local dates), as UTC instants. */
function bounds(dr: MaintenanceDraft): { from: number | null; until: number | null } {
  const a = parseDate(dr.startLocal);
  const b = parseDate(dr.endLocal);
  return {
    from: a ? zonedTimeToUtc(a.y, a.m, a.d, 0, 0, dr.tz) : null,
    until: b ? zonedTimeToUtc(b.y, b.m, b.d, 0, 0, dr.tz) + DAY : null,
  };
}

/**
 * The next `count` windows (current one included) of a draft, starting the search a
 * day before `now` so that a window in progress is found. Empty for manual/invalid drafts.
 */
export function nextWindows(dr: MaintenanceDraft, now: number, count = 3, horizonDays = 400): Window[] {
  if (!isValidTimeZone(dr.tz)) return [];
  const out: Window[] = [];
  if (dr.strategy === 'manual') return out;
  if (dr.strategy === 'single') {
    const a = parseDateTime(dr.startLocal);
    const b = parseDateTime(dr.endLocal);
    if (!a || !b) return out;
    const start = zonedTimeToUtc(a.y, a.m, a.d, a.h, a.min, dr.tz);
    const end = zonedTimeToUtc(b.y, b.m, b.d, b.h, b.min, dr.tz);
    if (end > start && end > now) out.push({ start, end });
    return out;
  }
  const { from, until } = bounds(dr);
  const push = (start: number, duration: number) => {
    const end = start + duration;
    if (end <= now) return;
    if (from !== null && start < from) return;
    if (until !== null && start >= until) return;
    if (out.length && out[out.length - 1]!.start === start) return;
    out.push({ start, end });
  };
  const searchFrom = Math.max(now - DAY, from ?? -Infinity);

  if (dr.strategy === 'cron') {
    const c = parseCron(dr.cron);
    const dur = (dr.durationMin ?? 0) * MIN;
    if (typeof c === 'string' || dur <= 0) return out;
    const hours = [...c.hours].sort((x, y) => x - y);
    const minutes = [...c.minutes].sort((x, y) => x - y);
    for (const day of localDays(searchFrom, dr.tz, horizonDays)) {
      if (!cronDayMatches(c, day.y, day.m, day.d, day.dow)) continue;
      for (const h of hours) {
        for (const mi of minutes) {
          push(zonedTimeToUtc(day.y, day.m, day.d, h, mi, dr.tz), dur);
          if (out.length >= count) return out;
        }
      }
    }
    return out;
  }

  const t = parseTime(dr.timeStart);
  const dur = dailyDuration(dr.timeStart, dr.timeEnd);
  if (!t || dur === null) return out;
  const anchor = parseDate(dr.startLocal);
  for (const day of localDays(searchFrom, dr.tz, horizonDays)) {
    let match = false;
    if (dr.strategy === 'weekly') match = dr.weekdays.includes(day.dow);
    else if (dr.strategy === 'monthly') match = dr.daysOfMonth.some((x) => (x === 'L' ? day.d === daysInMonth(day.y, day.m) : x === day.d));
    else if (dr.strategy === 'interval') {
      const n = dr.intervalDays ?? 0;
      if (!anchor || !Number.isInteger(n) || n < 1) return out;
      const diff = dayNumber(day.y, day.m, day.d) - dayNumber(anchor.y, anchor.m, anchor.d);
      match = diff >= 0 && diff % n === 0;
    }
    if (!match) continue;
    push(zonedTimeToUtc(day.y, day.m, day.d, t.h, t.min, dr.tz), dur);
    if (out.length >= count) break;
  }
  return out;
}

/* ---------------- validation / mapping ---------------- */

export type DraftErrors = Partial<Record<keyof MaintenanceDraft, string>>;

/** Same limit as the server (400 `field: 'cron'`). */
export const MAX_CRON_RUNS_PER_DAY = 60;

/** API field -> draft field, for server validation errors. */
const SERVER_FIELDS: Record<string, keyof MaintenanceDraft> = {
  title: 'title',
  description: 'description',
  tz: 'tz',
  startsAt: 'startLocal',
  endsAt: 'endLocal',
  timeStart: 'timeStart',
  timeEnd: 'timeEnd',
  weekdays: 'weekdays',
  daysOfMonth: 'daysOfMonth',
  intervalDays: 'intervalDays',
  cron: 'cron',
  durationS: 'durationMin',
  monitorUids: 'monitorUids',
};

/**
 * Maps a failed save to a field error (400 with `field`, e.g. a cron that runs too often)
 * or a form-level message (409 window limit, 429 rate limit, anything else).
 */
export function mapMaintenanceError(err: unknown): { errors: DraftErrors; form: string | null } {
  const status = err instanceof ApiError ? err.status : 0;
  const message = err instanceof Error && err.message ? err.message : '';
  const key = err instanceof ApiError && err.field ? SERVER_FIELDS[err.field.replace(/\[\d+\]$/, '')] : undefined;
  if (key && message) return { errors: { [key]: message }, form: null };
  if (status === 429) return { errors: {}, form: message || 'Too many changes in a short time. Wait a moment and try again.' };
  if (status === 409) return { errors: {}, form: message || 'You have reached the maximum number of maintenance windows of this kind.' };
  return { errors: {}, form: message || 'Could not save.' };
}

export function validateMaintenance(dr: MaintenanceDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!dr.title.trim()) e.title = 'Enter a title.';
  else if (dr.title.length > 150) e.title = 'At most 150 characters.';
  if (dr.description.length > 5000) e.description = 'At most 5000 characters.';
  if (!isValidTimeZone(dr.tz)) e.tz = 'Pick a valid time zone.';
  const recurring = dr.strategy === 'weekly' || dr.strategy === 'monthly' || dr.strategy === 'interval';
  if (dr.strategy === 'single') {
    const a = parseDateTime(dr.startLocal);
    const b = parseDateTime(dr.endLocal);
    if (!a) e.startLocal = 'Pick a start date and time.';
    if (!b) e.endLocal = 'Pick an end date and time.';
    if (a && b && !e.tz && zonedTimeToUtc(b.y, b.m, b.d, b.h, b.min, dr.tz) <= zonedTimeToUtc(a.y, a.m, a.d, a.h, a.min, dr.tz)) e.endLocal = 'The end must be after the start.';
  } else if (dr.strategy !== 'manual') {
    if (dr.startLocal && !parseDate(dr.startLocal)) e.startLocal = 'Invalid date.';
    if (dr.endLocal && !parseDate(dr.endLocal)) e.endLocal = 'Invalid date.';
    if (!e.startLocal && !e.endLocal && dr.startLocal && dr.endLocal && dr.endLocal < dr.startLocal) e.endLocal = 'Must be on or after the start date.';
  }
  if (recurring) {
    if (!parseTime(dr.timeStart)) e.timeStart = 'Use HH:mm.';
    if (!parseTime(dr.timeEnd)) e.timeEnd = 'Use HH:mm.';
    if (!e.timeStart && !e.timeEnd && dr.timeStart === dr.timeEnd) e.timeEnd = 'Start and end time must differ.';
  }
  if (dr.strategy === 'weekly' && dr.weekdays.length === 0) e.weekdays = 'Pick at least one weekday.';
  if (dr.strategy === 'monthly' && dr.daysOfMonth.length === 0) e.daysOfMonth = 'Pick at least one day.';
  if (dr.strategy === 'interval') {
    if (!Number.isInteger(dr.intervalDays) || (dr.intervalDays ?? 0) < 1 || (dr.intervalDays ?? 0) > 3650) e.intervalDays = 'Enter 1–3650 days.';
    if (!dr.startLocal) e.startLocal = 'Pick the first day.';
  }
  if (dr.strategy === 'cron') {
    const c = parseCron(dr.cron);
    if (typeof c === 'string') e.cron = c;
    else if (c.minutes.size * c.hours.size > MAX_CRON_RUNS_PER_DAY) e.cron = `Runs ${c.minutes.size * c.hours.size} times a day; at most ${MAX_CRON_RUNS_PER_DAY} are allowed.`;
    if (!Number.isFinite(dr.durationMin) || (dr.durationMin ?? 0) < 1 || (dr.durationMin ?? 0) > 7 * 24 * 60) e.durationMin = 'Enter 1 minute to 7 days.';
  }
  return e;
}

export function emptyDraft(tz: string, now = Date.now()): MaintenanceDraft {
  const start = Math.ceil(now / (60 * MIN)) * 60 * MIN + 60 * MIN;
  return {
    title: '',
    description: '',
    active: true,
    strategy: 'single',
    tz,
    startLocal: toLocalDateTime(start, tz),
    endLocal: toLocalDateTime(start + 2 * 60 * MIN, tz),
    timeStart: '02:00',
    timeEnd: '03:00',
    weekdays: [0],
    daysOfMonth: [1],
    intervalDays: 7,
    cron: '30 2 * * 0',
    durationMin: 60,
    monitorUids: [],
    statusPageUids: [],
  };
}

export function draftFromMaintenance(m: Maintenance, now = Date.now()): MaintenanceDraft {
  const tz = isValidTimeZone(m.tz) ? m.tz : 'UTC';
  const base = emptyDraft(tz, now);
  const single = m.strategy === 'single';
  return {
    ...base,
    title: m.title,
    description: m.description ?? '',
    active: m.active,
    strategy: m.strategy,
    tz,
    startLocal: m.startsAt !== null ? (single ? toLocalDateTime(m.startsAt, tz) : toLocalDate(m.startsAt, tz)) : single ? base.startLocal : '',
    endLocal:
      m.endsAt !== null ? (single ? toLocalDateTime(m.endsAt, tz) : toLocalDate(m.endsAt - 1, tz)) : single ? base.endLocal : '',
    timeStart: m.timeStart ?? base.timeStart,
    timeEnd: m.timeEnd ?? base.timeEnd,
    weekdays: m.weekdays.length ? [...m.weekdays] : base.weekdays,
    daysOfMonth: m.daysOfMonth.length ? [...m.daysOfMonth] : base.daysOfMonth,
    intervalDays: m.intervalDays ?? base.intervalDays,
    cron: m.cron ?? base.cron,
    durationMin: m.durationS !== null ? Math.round(m.durationS / 60) : base.durationMin,
    monitorUids: [...m.monitorUids],
    statusPageUids: [...m.statusPageUids],
  };
}

/** API body of a (validated) draft. */
export function draftToInput(dr: MaintenanceDraft): MaintenanceInput {
  const single = dr.strategy === 'single';
  let startsAt: number | null = null;
  let endsAt: number | null = null;
  if (single) {
    const a = parseDateTime(dr.startLocal);
    const b = parseDateTime(dr.endLocal);
    startsAt = a ? zonedTimeToUtc(a.y, a.m, a.d, a.h, a.min, dr.tz) : null;
    endsAt = b ? zonedTimeToUtc(b.y, b.m, b.d, b.h, b.min, dr.tz) : null;
  } else if (dr.strategy !== 'manual') {
    const bd = bounds(dr);
    startsAt = bd.from;
    endsAt = bd.until;
  }
  const recurring = dr.strategy === 'weekly' || dr.strategy === 'monthly' || dr.strategy === 'interval';
  const dur = recurring ? dailyDuration(dr.timeStart, dr.timeEnd) : dr.strategy === 'cron' ? (dr.durationMin ?? 0) * MIN : null;
  return {
    title: dr.title.trim(),
    description: dr.description.trim() || null,
    active: dr.active,
    strategy: dr.strategy,
    tz: dr.tz,
    startsAt,
    endsAt,
    timeStart: recurring ? dr.timeStart : null,
    timeEnd: recurring ? dr.timeEnd : null,
    weekdays: dr.strategy === 'weekly' ? [...dr.weekdays].sort((a, b) => a - b) : [],
    daysOfMonth: dr.strategy === 'monthly' ? sortDays(dr.daysOfMonth) : [],
    intervalDays: dr.strategy === 'interval' ? (dr.intervalDays ?? null) : null,
    cron: dr.strategy === 'cron' ? dr.cron.trim().replace(/\s+/g, ' ') : null,
    durationS: dur === null ? null : Math.round(dur / 1000),
    monitorUids: [...dr.monitorUids],
    statusPageUids: [...dr.statusPageUids],
  };
}

function sortDays(days: ReadonlyArray<number | 'L'>): Array<number | 'L'> {
  const nums = days.filter((d): d is number => d !== 'L').sort((a, b) => a - b);
  return days.includes('L') ? [...nums, 'L'] : nums;
}

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Short schedule description for the list ("Weekly on Sun, Wed · 02:00–03:00"). */
export function describeSchedule(m: Pick<Maintenance, 'strategy' | 'weekdays' | 'daysOfMonth' | 'intervalDays' | 'cron' | 'timeStart' | 'timeEnd' | 'durationS' | 'tz'>): string {
  const time = m.timeStart && m.timeEnd ? ` · ${m.timeStart}–${m.timeEnd}` : '';
  switch (m.strategy) {
    case 'manual':
      return 'Manual — active while switched on';
    case 'single':
      return 'One-time window';
    case 'weekly': {
      const days = m.weekdays.length === 7 ? 'every day' : m.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ');
      return `Weekly on ${days}${time}`;
    }
    case 'monthly':
      return `Monthly on day ${m.daysOfMonth.map((d) => (d === 'L' ? 'last' : String(d))).join(', ')}${time}`;
    case 'interval':
      return `Every ${m.intervalDays ?? '?'} ${m.intervalDays === 1 ? 'day' : 'days'}${time}`;
    case 'cron':
      return `Cron ${m.cron ?? ''}${m.durationS ? ` · ${Math.round(m.durationS / 60)} min` : ''}`;
  }
}
