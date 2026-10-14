// Maintenance windows (ANALYSIS §6): pure, restart-safe evaluation of `strategy` in an IANA time
// zone (DST-correct through Intl, lib/time). No timers: the engine asks "is t inside a window?".
//
// Cost (audit HIGH 2): every evaluation is bounded by a few Intl calls, whatever the schedule.
// Local→UTC conversion uses one cached offset per (zone, local day) when the day has no DST
// transition (3 Intl calls per day, cached) and falls back to zonedTime() on transition days only.
// Cron occurrences are never enumerated: the latest / first occurrence around an instant is found
// by binary search over the (sorted, monotonic) hour×minute combinations of one day, and nothing
// is evaluated outside the validity range startsAt..endsAt.
import { addDays, localDateOf, tzOffset, type LocalDate } from '../../lib/time.js';
import { cronDayMatches, daysInMonth, parseCron, type CronSpec } from './cron.js';

export type Strategy = 'manual' | 'single' | 'weekly' | 'monthly' | 'interval' | 'cron';
export const STRATEGIES: readonly Strategy[] = ['manual', 'single', 'weekly', 'monthly', 'interval', 'cron'];
export type DayOfMonth = number | 'L';
export type MaintenanceStatus = 'scheduled' | 'under-maintenance' | 'inactive' | 'ended';

export interface MaintenanceDef {
  strategy: Strategy;
  active: boolean;
  tz: string;
  /** single: window start; recurring: first day the schedule applies (optional). ms epoch. */
  startsAt: number | null;
  /** single: window end; recurring: no window starts at or after this instant (optional). */
  endsAt: number | null;
  /** 'HH:MM' local (weekly, monthly, interval). */
  timeStart: string | null;
  timeEnd: string | null;
  weekdays: number[]; // 0 = Sunday
  daysOfMonth: DayOfMonth[];
  intervalDays: number | null;
  cron: string | null;
  /** cron: window length. */
  durationS: number | null;
}

export interface Window {
  start: number;
  end: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Forward search horizon for recurring strategies (bounded work). */
const MAX_SCAN_DAYS = 5 * 366 + 2;

/** Instant of local wall-clock time y-m-d h:mi in `tz` (gap → end of the gap, overlap → earlier). */
export function zonedTime(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d, h, mi, 0);
  const offsets = new Set([tzOffset(naive - 14 * 3_600_000, tz), tzOffset(naive, tz), tzOffset(naive + 14 * 3_600_000, tz)]);
  const candidates = [...offsets].map((o) => naive - o);
  const valid = candidates.filter((t) => tzOffset(t, tz) === naive - t);
  if (valid.length > 0) return Math.min(...valid);
  // In a gap (spring forward): the transition instant itself, like lib/time zonedStart.
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  const before = tzOffset(lo, tz);
  for (let i = 0; i < 40 && hi - lo > 1000; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (tzOffset(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return Math.floor(hi / 60_000) * 60_000;
}

export function parseHHMM(s: string | null): { h: number; mi: number } | null {
  if (typeof s !== 'string' || s.length !== 5 || s[2] !== ':') return null;
  const h = Number(s.slice(0, 2));
  const mi = Number(s.slice(3, 5));
  if (!/^\d\d$/.test(s.slice(0, 2)) || !/^\d\d$/.test(s.slice(3, 5))) return null;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

const dateKey = (d: LocalDate): number => Date.UTC(d.y, d.m - 1, d.d);

/** (zone, local day) → the UTC offset valid for the whole day, or null when the day has a transition. */
const dayOffsets = new Map<string, number | null>();
const MAX_DAY_OFFSETS = 20_000;

function dayOffset(d: LocalDate, tz: string): number | null {
  const key = `${tz}|${d.y}-${d.m}-${d.d}`;
  let off = dayOffsets.get(key);
  if (off === undefined) {
    const start = dateKey(d);
    // Every instant of the local day lies within [start - 14 h, start + 1 d + 14 h].
    const a = tzOffset(start - 14 * HOUR, tz);
    const b = tzOffset(start + 12 * HOUR, tz);
    const c = tzOffset(start + DAY + 14 * HOUR, tz);
    off = a === b && b === c ? a : null;
    if (dayOffsets.size >= MAX_DAY_OFFSETS) dayOffsets.clear();
    dayOffsets.set(key, off);
  }
  return off;
}

/** zonedTime() with a fast path for days without a DST transition. */
export function localInstant(d: LocalDate, h: number, mi: number, tz: string): number {
  const off = dayOffset(d, tz);
  if (off !== null) return Date.UTC(d.y, d.m - 1, d.d, h, mi, 0) - off;
  return zonedTime(d.y, d.m, d.d, h, mi, tz);
}
const weekday = (d: LocalDate): number => new Date(dateKey(d)).getUTCDay();

/** First local day of an `interval` schedule (computed once per evaluation, not per scanned day). */
function intervalFirst(def: MaintenanceDef): LocalDate | null {
  if (def.strategy !== 'interval' || def.startsAt === null || !def.intervalDays || def.intervalDays < 1) return null;
  return localDateOf(def.startsAt, def.tz);
}

/** Does a day-based strategy (weekly, monthly, interval) start a window on local date `d`? */
function dayMatches(def: MaintenanceDef, d: LocalDate, first: LocalDate | null): boolean {
  switch (def.strategy) {
    case 'weekly':
      return def.weekdays.includes(weekday(d));
    case 'monthly':
      return def.daysOfMonth.some((x) => (x === 'L' ? d.d === daysInMonth(d.y, d.m) : x === d.d));
    case 'interval': {
      if (first === null || !def.intervalDays) return false;
      const diff = Math.round((dateKey(d) - dateKey(first)) / DAY);
      return diff >= 0 && diff % def.intervalDays === 0;
    }
    default:
      return false;
  }
}

/** The window a day-based strategy opens on local date `d` (end crosses midnight when needed). */
function dayWindow(def: MaintenanceDef, d: LocalDate): Window | null {
  const s = parseHHMM(def.timeStart);
  const e = parseHHMM(def.timeEnd);
  if (!s || !e) return null;
  const start = localInstant(d, s.h, s.mi, def.tz);
  const crosses = e.h * 60 + e.mi <= s.h * 60 + s.mi;
  const endDate = crosses ? addDays(d, 1) : d;
  const end = localInstant(endDate, e.h, e.mi, def.tz);
  return end > start ? { start, end } : null;
}

function inValidity(def: MaintenanceDef, w: Window): boolean {
  if (def.strategy !== 'interval' && def.startsAt !== null && w.start < def.startsAt) return false;
  if (def.strategy === 'interval' && def.startsAt !== null && w.start < def.startsAt - DAY) return false;
  if (def.endsAt !== null && w.start >= def.endsAt) return false;
  return true;
}

const cronCache = new Map<string, CronSpec | null>();
function cronSpec(expr: string | null): CronSpec | null {
  if (!expr) return null;
  let spec = cronCache.get(expr);
  if (spec === undefined) {
    try {
      spec = parseCron(expr);
    } catch {
      spec = null;
    }
    if (cronCache.size > 1000) cronCache.clear();
    cronCache.set(expr, spec);
  }
  return spec;
}

/** Number of hour×minute combinations a cron matches per day (validation caps it). */
export function cronCombinations(spec: CronSpec): number {
  return spec.hours.length * spec.minutes.length;
}

/** Instant of the i-th (ascending) hour×minute combination of `spec` on local day d. */
function cronAt(spec: CronSpec, d: LocalDate, tz: string, i: number): number {
  const m = spec.minutes.length;
  return localInstant(d, spec.hours[Math.floor(i / m)] as number, spec.minutes[i % m] as number, tz);
}

/**
 * Latest occurrence on local day d at or before `limit` (null when none). The combinations are
 * sorted and local→UTC is monotonic (gap times collapse onto the transition, overlaps resolve to
 * the earlier instant), so a binary search needs O(log 1440) conversions.
 */
function cronLatest(spec: CronSpec, d: LocalDate, tz: string, limit: number): number | null {
  if (!cronDayMatches(spec, d.y, d.m, d.d)) return null;
  const n = cronCombinations(spec);
  if (n === 0) return null;
  const last = cronAt(spec, d, tz, n - 1);
  if (last <= limit) return last;
  if (cronAt(spec, d, tz, 0) > limit) return null;
  let lo = 0; // at(lo) <= limit
  let hi = n - 1; // at(hi) > limit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cronAt(spec, d, tz, mid) <= limit) lo = mid;
    else hi = mid;
  }
  return cronAt(spec, d, tz, lo);
}

/** First occurrence on local day d at or after `from` (null when none). */
function cronFirst(spec: CronSpec, d: LocalDate, tz: string, from: number): number | null {
  if (!cronDayMatches(spec, d.y, d.m, d.d)) return null;
  const n = cronCombinations(spec);
  if (n === 0) return null;
  const first = cronAt(spec, d, tz, 0);
  if (first >= from) return first;
  if (cronAt(spec, d, tz, n - 1) < from) return null;
  let lo = 0; // at(lo) < from
  let hi = n - 1; // at(hi) >= from
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cronAt(spec, d, tz, mid) >= from) hi = mid;
    else lo = mid;
  }
  return cronAt(spec, d, tz, hi);
}

/** The window containing `now`, or null. Ignores `active` (see currentWindow). */
function windowAt(def: MaintenanceDef, now: number): Window | null {
  switch (def.strategy) {
    case 'manual':
      return null;
    case 'single':
      if (def.startsAt === null || def.endsAt === null) return null;
      return def.startsAt <= now && now < def.endsAt ? { start: def.startsAt, end: def.endsAt } : null;
    case 'weekly':
    case 'monthly':
    case 'interval': {
      // Windows last at most ~25 h and start within the validity range.
      if (def.startsAt !== null && now < def.startsAt - DAY) return null;
      if (def.endsAt !== null && now >= def.endsAt + 2 * DAY) return null;
      const first = intervalFirst(def);
      const today = localDateOf(now, def.tz);
      // They started today, yesterday or (DST) the day before.
      for (let back = 0; back <= 2; back++) {
        const d = addDays(today, -back);
        if (!dayMatches(def, d, first)) continue;
        const w = dayWindow(def, d);
        if (w && w.start <= now && now < w.end && inValidity(def, w)) return w;
      }
      return null;
    }
    case 'cron': {
      const spec = cronSpec(def.cron);
      const dur = (def.durationS ?? 0) * 1000;
      if (!spec || dur <= 0) return null;
      // Windows start in [startsAt, endsAt) and last `dur`: nothing to evaluate outside that.
      if (def.startsAt !== null && now < def.startsAt) return null;
      if (def.endsAt !== null && now >= def.endsAt + dur) return null;
      const today = localDateOf(now, def.tz);
      const backDays = Math.ceil(dur / DAY) + 1;
      // Latest occurrence <= now: walk days backwards; the first one found is the latest.
      for (let back = 0; back <= backDays; back++) {
        const latest = cronLatest(spec, addDays(today, -back), def.tz, now);
        if (latest === null) continue;
        const w = { start: latest, end: latest + dur };
        return now < w.end && inValidity(def, w) ? w : null;
      }
      return null;
    }
  }
}

/** The active window containing `now`; manual windows are open-ended ({start: 0, end: Infinity}). */
export function currentWindow(def: MaintenanceDef, now: number): Window | null {
  if (!def.active) return null;
  if (def.strategy === 'manual') return { start: 0, end: Number.POSITIVE_INFINITY };
  return windowAt(def, now);
}

/** First window starting after `now` (ignores `active`). */
function upcoming(def: MaintenanceDef, now: number): Window | null {
  switch (def.strategy) {
    case 'manual':
      return null;
    case 'single':
      return def.startsAt !== null && def.endsAt !== null && def.startsAt > now ? { start: def.startsAt, end: def.endsAt } : null;
    case 'weekly':
    case 'monthly':
    case 'interval': {
      if (def.strategy === 'weekly' && def.weekdays.length === 0) return null;
      if (def.strategy === 'monthly' && def.daysOfMonth.length === 0) return null;
      if (def.endsAt !== null && now >= def.endsAt) return null;
      const first = intervalFirst(def);
      if (def.strategy === 'interval' && first === null) return null;
      let d = localDateOf(Math.max(now, def.startsAt !== null && def.strategy !== 'interval' ? def.startsAt - DAY : now), def.tz);
      for (let i = 0; i < MAX_SCAN_DAYS; i++, d = addDays(d, 1)) {
        if (!dayMatches(def, d, first)) continue;
        const w = dayWindow(def, d);
        if (!w || w.start <= now) continue;
        if (def.endsAt !== null && w.start >= def.endsAt) return null;
        if (inValidity(def, w)) return w;
      }
      return null;
    }
    case 'cron': {
      const spec = cronSpec(def.cron);
      const dur = (def.durationS ?? 0) * 1000;
      if (!spec || dur <= 0) return null;
      // First occurrence strictly after now and not before startsAt.
      const from = Math.max(now + 1, def.startsAt ?? Number.NEGATIVE_INFINITY);
      if (def.endsAt !== null && from >= def.endsAt) return null;
      let d = localDateOf(from, def.tz);
      // Days that do not match are skipped with plain calendar arithmetic (no Intl calls).
      for (let i = 0; i < MAX_SCAN_DAYS; i++, d = addDays(d, 1)) {
        const t = cronFirst(spec, d, def.tz, from);
        if (t === null) continue;
        const w = { start: t, end: t + dur };
        if (def.endsAt !== null && w.start >= def.endsAt) return null;
        return w;
      }
      return null;
    }
  }
}

/** The current window, or else the next one (null when none / manual). */
export function nextWindow(def: MaintenanceDef, now: number): Window | null {
  if (def.strategy === 'manual') return null;
  const cur = def.active ? windowAt(def, now) : null;
  if (cur) return cur;
  return upcoming(def, now);
}

export function maintenanceStatus(def: MaintenanceDef, now: number): MaintenanceStatus {
  if (!def.active) return 'inactive';
  if (currentWindow(def, now)) return 'under-maintenance';
  if (def.strategy === 'manual') return 'inactive';
  if (def.endsAt !== null && now >= def.endsAt) return 'ended';
  return upcoming(def, now) ? 'scheduled' : 'ended';
}
