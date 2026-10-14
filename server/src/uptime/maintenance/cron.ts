// Small, safe 5-field cron parser (minute hour day-of-month month day-of-week). No regular
// expressions over user input beyond fixed, linear token checks; every loop is bounded.
//
// Supported: `*`, `?` (= `*`), numbers, ranges `a-b`, steps `*/n` and `a-b/n` and `a/n`, lists,
// month names (JAN–DEC), weekday names (SUN–SAT, 7 = Sunday), `L` (last day of the month) in the
// day-of-month field, and the macros @yearly @annually @monthly @weekly @daily @midnight @hourly.
// Day matching follows Vixie cron: when both day-of-month and day-of-week are restricted, a day
// matches if EITHER matches.

export class CronError extends Error {
  override name = 'CronError';
}

export interface CronSpec {
  minutes: number[]; // sorted, unique
  hours: number[];
  dom: boolean[]; // index 1..31
  lastDom: boolean;
  months: boolean[]; // index 1..12
  dow: boolean[]; // index 0..6 (0 = Sunday)
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MAX_EXPR = 120;
const MAX_ITEMS = 60;

function isDigits(s: string): boolean {
  if (s.length === 0 || s.length > 4) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Offset added to a name's index (months are 1-based). */
  nameBase?: number;
}

function value(token: string, f: FieldDef): number {
  const upper = token.toUpperCase();
  if (f.names) {
    const idx = f.names.indexOf(upper);
    if (idx !== -1) return idx + (f.nameBase ?? 0);
  }
  if (!isDigits(token)) throw new CronError(`invalid ${f.name} value "${token.slice(0, 10)}"`);
  const n = Number(token);
  // Day of week 7 = Sunday.
  const max = f.name === 'day-of-week' ? 7 : f.max;
  if (n < f.min || n > max) throw new CronError(`${f.name} value ${n} out of range ${f.min}-${f.max}`);
  return n;
}

/** Parse one field into a boolean table (index = value). Returns [table, restricted, lastDay]. */
function parseField(text: string, f: FieldDef, allowL: boolean): { table: boolean[]; restricted: boolean; last: boolean } {
  const size = f.name === 'day-of-week' ? 8 : f.max + 1;
  const table = new Array<boolean>(size).fill(false);
  let last = false;
  if (text === '*' || text === '?') {
    for (let v = f.min; v <= f.max; v++) table[v] = true;
    return { table, restricted: false, last };
  }
  const items = text.split(',');
  if (items.length > MAX_ITEMS) throw new CronError(`too many items in ${f.name}`);
  for (const item of items) {
    if (item.length === 0) throw new CronError(`empty item in ${f.name}`);
    if (allowL && item.toUpperCase() === 'L') {
      last = true;
      continue;
    }
    const slash = item.split('/');
    if (slash.length > 2) throw new CronError(`invalid step in ${f.name}`);
    const base = slash[0] as string;
    let step = 1;
    if (slash.length === 2) {
      const s = slash[1] as string;
      if (!isDigits(s)) throw new CronError(`invalid step in ${f.name}`);
      step = Number(s);
      if (step < 1 || step > f.max + 1) throw new CronError(`invalid step in ${f.name}`);
    }
    let lo: number;
    let hi: number;
    if (base === '*' || base === '?') {
      lo = f.min;
      hi = f.max;
    } else {
      const dash = base.split('-');
      if (dash.length > 2) throw new CronError(`invalid range in ${f.name}`);
      lo = value(dash[0] as string, f);
      if (dash.length === 2) hi = value(dash[1] as string, f);
      else hi = slash.length === 2 ? (f.name === 'day-of-week' ? 6 : f.max) : lo; // "a/n" = a..max step n
      if (hi < lo) throw new CronError(`invalid range in ${f.name}`);
    }
    for (let v = lo; v <= hi; v += step) table[v] = true;
  }
  // Vixie cron: a field starting with "*" (e.g. "*/2") counts as unrestricted for day matching.
  return { table, restricted: !(text.startsWith('*') || text.startsWith('?')), last };
}

export function parseCron(expr: string): CronSpec {
  if (typeof expr !== 'string') throw new CronError('cron must be a string');
  let text = expr.trim();
  if (text.length === 0 || text.length > MAX_EXPR) throw new CronError('invalid cron expression');
  const macro = MACROS[text.toLowerCase()];
  if (macro) text = macro;
  const parts = text.split(' ').filter((p) => p.length > 0);
  if (parts.length !== 5) throw new CronError('cron needs 5 fields: minute hour day-of-month month day-of-week');
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(mi, { name: 'minute', min: 0, max: 59 }, false);
  const hours = parseField(h, { name: 'hour', min: 0, max: 23 }, false);
  const days = parseField(dom, { name: 'day-of-month', min: 1, max: 31 }, true);
  const months = parseField(mo, { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 }, false);
  const weekdays = parseField(dow, { name: 'day-of-week', min: 0, max: 6, names: DAYS, nameBase: 0 }, false);
  const dowTable = weekdays.table.slice(0, 7);
  if (weekdays.table[7]) dowTable[0] = true;
  const spec: CronSpec = {
    minutes: indices(minutes.table),
    hours: indices(hours.table),
    dom: days.table,
    lastDom: days.last,
    months: months.table,
    dow: dowTable,
    domRestricted: days.restricted,
    dowRestricted: weekdays.restricted,
  };
  if (spec.minutes.length === 0 || spec.hours.length === 0) throw new CronError('cron never matches');
  if (!spec.months.some(Boolean)) throw new CronError('cron never matches');
  // A day-of-month list that can never occur in any selected month (e.g. 31 in February only).
  let possible = false;
  for (let m = 1; m <= 12 && !possible; m++) {
    if (!spec.months[m]) continue;
    const maxDay = m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31;
    if (spec.dowRestricted || spec.lastDom) possible = true;
    for (let d = 1; d <= maxDay && !possible; d++) if (spec.dom[d]) possible = true;
  }
  if (!possible) throw new CronError('cron never matches');
  return spec;
}

function indices(table: boolean[]): number[] {
  const out: number[] = [];
  table.forEach((v, i) => {
    if (v) out.push(i);
  });
  return out;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Does the calendar day y-m-d match the day-of-month / month / day-of-week fields? */
export function cronDayMatches(spec: CronSpec, y: number, m: number, d: number): boolean {
  if (!spec.months[m]) return false;
  const domMatch = spec.dom[d] === true || (spec.lastDom && d === daysInMonth(y, m));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const dowMatch = spec.dow[dow] === true;
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}
