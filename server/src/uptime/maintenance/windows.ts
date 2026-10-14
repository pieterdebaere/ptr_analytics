// Maintenance windows (ANALYSIS §6): pure, restart-safe evaluation of `strategy` in an IANA time
// zone (DST-correct through Intl, lib/time). No timers: the engine asks "is t inside a window?".
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
const weekday = (d: LocalDate): number => new Date(dateKey(d)).getUTCDay();

/** Does a day-based strategy (weekly, monthly, interval) start a window on local date `d`? */
function dayMatches(def: MaintenanceDef, d: LocalDate): boolean {
  switch (def.strategy) {
    case 'weekly':
      return def.weekdays.includes(weekday(d));
    case 'monthly':
      return def.daysOfMonth.some((x) => (x === 'L' ? d.d === daysInMonth(d.y, d.m) : x === d.d));
    case 'interval': {
      if (def.startsAt === null || !def.intervalDays || def.intervalDays < 1) return false;
      const first = localDateOf(def.startsAt, def.tz);
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
  const start = zonedTime(d.y, d.m, d.d, s.h, s.mi, def.tz);
  const crosses = e.h * 60 + e.mi <= s.h * 60 + s.mi;
  const endDate = crosses ? addDays(d, 1) : d;
  const end = zonedTime(endDate.y, endDate.m, endDate.d, e.h, e.mi, def.tz);
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

/** Cron occurrences on local date d, ascending. */
function cronStarts(spec: CronSpec, d: LocalDate, tz: string): number[] {
  if (!cronDayMatches(spec, d.y, d.m, d.d)) return [];
  const out: number[] = [];
  let last = -Infinity;
  for (const h of spec.hours) {
    for (const mi of spec.minutes) {
      const t = zonedTime(d.y, d.m, d.d, h, mi, tz);
      // Times inside a DST gap collapse onto the transition instant: keep one.
      if (t > last) {
        out.push(t);
        last = t;
      }
    }
  }
  return out;
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
      const today = localDateOf(now, def.tz);
      // Windows last at most ~25 h: they started today, yesterday or (DST) the day before.
      for (let back = 0; back <= 2; back++) {
        const d = addDays(today, -back);
        if (!dayMatches(def, d)) continue;
        const w = dayWindow(def, d);
        if (w && w.start <= now && now < w.end && inValidity(def, w)) return w;
      }
      return null;
    }
    case 'cron': {
      const spec = cronSpec(def.cron);
      const dur = (def.durationS ?? 0) * 1000;
      if (!spec || dur <= 0) return null;
      const today = localDateOf(now, def.tz);
      const backDays = Math.ceil(dur / DAY) + 1;
      // Latest occurrence <= now: scan days backwards; the first one found is the latest.
      for (let back = 0; back <= backDays; back++) {
        const starts = cronStarts(spec, addDays(today, -back), def.tz).filter((t) => t <= now);
        const latest = starts[starts.length - 1];
        if (latest === undefined) continue;
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
      let d = localDateOf(Math.max(now, def.startsAt !== null && def.strategy !== 'interval' ? def.startsAt - DAY : now), def.tz);
      for (let i = 0; i < MAX_SCAN_DAYS; i++, d = addDays(d, 1)) {
        if (!dayMatches(def, d)) continue;
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
      let d = localDateOf(Math.max(now, def.startsAt ?? now), def.tz);
      for (let i = 0; i < MAX_SCAN_DAYS; i++, d = addDays(d, 1)) {
        for (const t of cronStarts(spec, d, def.tz)) {
          if (t <= now) continue;
          const w = { start: t, end: t + dur };
          if (def.endsAt !== null && w.start >= def.endsAt) return null;
          if (inValidity(def, w)) return w;
        }
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
