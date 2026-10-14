import { describe, expect, it } from 'vitest';
import { CronError, cronDayMatches, parseCron } from '../src/uptime/maintenance/cron.js';
import { withAncestors } from '../src/uptime/maintenance/index.js';
import { currentWindow, maintenanceStatus, nextWindow, zonedTime, type MaintenanceDef } from '../src/uptime/maintenance/windows.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;

const def = (d: Partial<MaintenanceDef>): MaintenanceDef => ({
  strategy: 'manual',
  active: true,
  tz: 'UTC',
  startsAt: null,
  endsAt: null,
  timeStart: null,
  timeEnd: null,
  weekdays: [],
  daysOfMonth: [],
  intervalDays: null,
  cron: null,
  durationS: null,
  ...d,
});

describe('cron parser', () => {
  it('parses fields, ranges, steps, lists and names', () => {
    const c = parseCron('*/15 9-17 * JAN,mar-may MON-FRI');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect(c.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.months.slice(1)).toEqual([true, false, true, true, true, false, false, false, false, false, false, false]);
    expect(c.dow).toEqual([false, true, true, true, true, true, false]);
    expect(c.domRestricted).toBe(false);
    expect(c.dowRestricted).toBe(true);
  });

  it('supports 7 = Sunday, a/n and macros', () => {
    expect(parseCron('0 0 * * 7').dow[0]).toBe(true);
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45]);
    expect(parseCron('@daily').hours).toEqual([0]);
    expect(parseCron('@hourly').minutes).toEqual([0]);
    expect(parseCron('@weekly').dow[0]).toBe(true);
  });

  it('L = last day of month', () => {
    const c = parseCron('0 3 L * *');
    expect(cronDayMatches(c, 2027, 2, 28)).toBe(true);
    expect(cronDayMatches(c, 2028, 2, 28)).toBe(false);
    expect(cronDayMatches(c, 2028, 2, 29)).toBe(true);
    expect(cronDayMatches(c, 2026, 4, 30)).toBe(true);
    expect(cronDayMatches(c, 2026, 5, 30)).toBe(false);
  });

  it('day-of-month OR day-of-week when both are restricted (Vixie)', () => {
    const c = parseCron('0 0 13 * FRI');
    expect(cronDayMatches(c, 2026, 2, 13)).toBe(true); // Friday the 13th
    expect(cronDayMatches(c, 2026, 3, 13)).toBe(true); // a Friday... or the 13th
    expect(cronDayMatches(c, 2026, 3, 6)).toBe(true); // Friday
    expect(cronDayMatches(c, 2026, 3, 7)).toBe(false);
    const star = parseCron('0 0 */2 * FRI'); // "*/2" counts as unrestricted
    expect(star.domRestricted).toBe(false);
    expect(cronDayMatches(star, 2026, 3, 7)).toBe(false);
    expect(cronDayMatches(star, 2026, 3, 6)).toBe(true);
  });

  it('rejects invalid expressions', () => {
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '5-1 * * * *',
      '*/0 * * * *',
      '1,,2 * * * *',
      'a * * * *',
      '* * L-1 * *',
      '0 0 30 2 *', // never matches
      '1-2-3 * * * *',
      '*/5/2 * * * *',
      'x'.repeat(200),
      '99999 * * * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
  });

  it('is linear on hostile input', () => {
    const evil = `${'1,'.repeat(40)}1 * * * *`;
    const t = performance.now();
    expect(() => parseCron(evil)).not.toThrow();
    expect(() => parseCron(`${'1-'.repeat(50)}1 * * * *`)).toThrow(CronError);
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe('zonedTime (DST)', () => {
  it('maps local wall-clock times to instants', () => {
    expect(zonedTime(2026, 7, 1, 12, 30, 'Europe/Brussels')).toBe(Date.UTC(2026, 6, 1, 10, 30));
    expect(zonedTime(2026, 1, 15, 12, 30, 'Europe/Brussels')).toBe(Date.UTC(2026, 0, 15, 11, 30));
    expect(zonedTime(2026, 1, 15, 5, 45, 'Asia/Kathmandu')).toBe(Date.UTC(2026, 0, 14, 24, 0));
  });

  it('nonexistent times (spring forward) resolve to the end of the gap; ambiguous ones to the earlier instant', () => {
    // Europe/Brussels 2026-03-29: 02:00 -> 03:00 (01:00 UTC)
    expect(zonedTime(2026, 3, 29, 2, 30, 'Europe/Brussels')).toBe(Date.UTC(2026, 2, 29, 1, 0));
    // 2026-10-25: 03:00 -> 02:00; 02:30 happens twice (00:30 and 01:30 UTC)
    expect(zonedTime(2026, 10, 25, 2, 30, 'Europe/Brussels')).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
});

describe('maintenance strategies', () => {
  it('manual: under maintenance while active', () => {
    const m = def({ strategy: 'manual' });
    expect(currentWindow(m, 0)).not.toBeNull();
    expect(maintenanceStatus(m, 0)).toBe('under-maintenance');
    expect(nextWindow(m, 0)).toBeNull();
    expect(maintenanceStatus({ ...m, active: false }, 0)).toBe('inactive');
    expect(currentWindow({ ...m, active: false }, 0)).toBeNull();
  });

  it('single: between startsAt and endsAt', () => {
    const start = Date.UTC(2026, 5, 20, 22);
    const m = def({ strategy: 'single', startsAt: start, endsAt: start + 2 * HOUR });
    expect(maintenanceStatus(m, start - 1)).toBe('scheduled');
    expect(nextWindow(m, start - 1)).toEqual({ start, end: start + 2 * HOUR });
    expect(currentWindow(m, start)).toEqual({ start, end: start + 2 * HOUR });
    expect(maintenanceStatus(m, start + HOUR)).toBe('under-maintenance');
    expect(currentWindow(m, start + 2 * HOUR)).toBeNull();
    expect(maintenanceStatus(m, start + 2 * HOUR)).toBe('ended');
    expect(maintenanceStatus({ ...m, active: false }, start + HOUR)).toBe('inactive');
  });

  it('weekly, crossing midnight, in a time zone', () => {
    // Mondays 23:00 - 01:00 Europe/Brussels (CEST in June: UTC+2)
    const m = def({ strategy: 'weekly', tz: 'Europe/Brussels', weekdays: [1], timeStart: '23:00', timeEnd: '01:00' });
    const monday = Date.UTC(2026, 5, 15, 21, 0); // Mon 2026-06-15 23:00 local
    expect(currentWindow(m, monday - 1)).toBeNull();
    expect(currentWindow(m, monday)).toEqual({ start: monday, end: monday + 2 * HOUR });
    expect(currentWindow(m, monday + 2 * HOUR - 1)).not.toBeNull();
    expect(currentWindow(m, monday + 2 * HOUR)).toBeNull();
    expect(nextWindow(m, monday + 2 * HOUR)).toEqual({ start: monday + 7 * DAY, end: monday + 7 * DAY + 2 * HOUR });
    expect(maintenanceStatus(m, monday + 3 * HOUR)).toBe('scheduled');
  });

  it('weekly across the spring-forward DST gap', () => {
    // Sunday 2026-03-29 02:30-03:30 Europe/Brussels: 02:30 does not exist -> starts at 03:00 CEST (01:00 UTC)
    const m = def({ strategy: 'weekly', tz: 'Europe/Brussels', weekdays: [0], timeStart: '02:30', timeEnd: '03:30' });
    const w = nextWindow(m, Date.UTC(2026, 2, 28));
    expect(w).toEqual({ start: Date.UTC(2026, 2, 29, 1, 0), end: Date.UTC(2026, 2, 29, 1, 30) });
    // the following Sunday is normal again (CEST): 02:30 local = 00:30 UTC
    expect(nextWindow(m, Date.UTC(2026, 2, 30))).toEqual({ start: Date.UTC(2026, 3, 5, 0, 30), end: Date.UTC(2026, 3, 5, 1, 30) });
  });

  it('weekly on the fall-back day keeps wall-clock bounds (window is one hour longer)', () => {
    const m = def({ strategy: 'weekly', tz: 'Europe/Brussels', weekdays: [0], timeStart: '01:00', timeEnd: '05:00' });
    const w = nextWindow(m, Date.UTC(2026, 9, 24));
    expect(w).toEqual({ start: Date.UTC(2026, 9, 24, 23, 0), end: Date.UTC(2026, 9, 25, 4, 0) });
    expect((w as { end: number; start: number }).end - (w as { start: number }).start).toBe(5 * HOUR);
  });

  it('monthly with explicit days and "L" (last day), skipping missing days', () => {
    const m = def({ strategy: 'monthly', tz: 'America/New_York', daysOfMonth: [31, 'L'], timeStart: '04:00', timeEnd: '05:00' });
    // From 2027-02-01: Feb has no 31st; L = Feb 28 (2027 not leap). New York in Feb: UTC-5
    expect(nextWindow(m, Date.UTC(2027, 1, 1))).toEqual({ start: Date.UTC(2027, 1, 28, 9), end: Date.UTC(2027, 1, 28, 10) });
    // 2028 is a leap year
    expect(nextWindow(m, Date.UTC(2028, 1, 1))?.start).toBe(Date.UTC(2028, 1, 29, 9));
    // March: the 31st (EDT, UTC-4) — "L" and 31 coincide
    expect(nextWindow(m, Date.UTC(2027, 2, 1))?.start).toBe(Date.UTC(2027, 2, 31, 8));
    // April: L = 30th
    expect(nextWindow(m, Date.UTC(2027, 3, 1))?.start).toBe(Date.UTC(2027, 3, 30, 8));
  });

  it('interval: every N days from the first day', () => {
    const first = Date.UTC(2026, 5, 1); // 2026-06-01 (UTC)
    const m = def({ strategy: 'interval', intervalDays: 3, startsAt: first, timeStart: '10:00', timeEnd: '11:00' });
    const starts: number[] = [];
    let t = first - DAY;
    for (let i = 0; i < 4; i++) {
      const w = nextWindow(m, t);
      if (!w) break;
      starts.push(w.start);
      t = w.end;
    }
    expect(starts).toEqual([0, 3, 6, 9].map((d) => first + d * DAY + 10 * HOUR));
    expect(currentWindow(m, first + 3 * DAY + 10 * HOUR + 30 * MIN)).not.toBeNull();
    expect(currentWindow(m, first + 4 * DAY + 10 * HOUR + 30 * MIN)).toBeNull();
  });

  it('recurring windows respect the validity range', () => {
    const m = def({
      strategy: 'weekly',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      timeStart: '12:00',
      timeEnd: '13:00',
      startsAt: Date.UTC(2026, 5, 10),
      endsAt: Date.UTC(2026, 5, 12),
    });
    expect(nextWindow(m, Date.UTC(2026, 5, 1))?.start).toBe(Date.UTC(2026, 5, 10, 12));
    expect(currentWindow(m, Date.UTC(2026, 5, 9, 12, 30))).toBeNull();
    expect(currentWindow(m, Date.UTC(2026, 5, 11, 12, 30))).not.toBeNull();
    expect(nextWindow(m, Date.UTC(2026, 5, 11, 14))).toBeNull();
    expect(maintenanceStatus(m, Date.UTC(2026, 5, 12, 0))).toBe('ended');
  });

  it('cron + duration in a time zone, current and next windows', () => {
    // weekdays at 03:00 Europe/Brussels for 90 minutes
    const m = def({ strategy: 'cron', tz: 'Europe/Brussels', cron: '0 3 * * 1-5', durationS: 90 * 60 });
    const fri = Date.UTC(2026, 5, 19, 1, 0); // Fri 2026-06-19 03:00 CEST
    expect(currentWindow(m, fri + 30 * MIN)).toEqual({ start: fri, end: fri + 90 * MIN });
    expect(currentWindow(m, fri + 90 * MIN)).toBeNull();
    // next after Friday's window: Monday
    expect(nextWindow(m, fri + 2 * HOUR)?.start).toBe(Date.UTC(2026, 5, 22, 1, 0));
  });

  it('cron windows longer than a day and over the DST gap', () => {
    const long = def({ strategy: 'cron', cron: '0 22 * * 6', durationS: 2 * 86_400 }); // Sat 22:00 for 48 h (UTC)
    const sat = Date.UTC(2026, 5, 20, 22);
    expect(currentWindow(long, sat + 40 * HOUR)).toEqual({ start: sat, end: sat + 48 * HOUR });
    const dst = def({ strategy: 'cron', tz: 'Europe/Brussels', cron: '30 2 * * *', durationS: 600 });
    expect(nextWindow(dst, Date.UTC(2026, 2, 28, 12))?.start).toBe(Date.UTC(2026, 2, 29, 1, 0));
    expect(nextWindow(dst, Date.UTC(2026, 2, 29, 12))?.start).toBe(Date.UTC(2026, 2, 30, 0, 30));
  });

  it('cron "L" maintenance on the last day of each month', () => {
    const m = def({ strategy: 'cron', cron: '0 1 L * *', durationS: 3600 });
    expect(nextWindow(m, Date.UTC(2027, 1, 2))?.start).toBe(Date.UTC(2027, 1, 28, 1));
    expect(nextWindow(m, Date.UTC(2027, 1, 28, 2))?.start).toBe(Date.UTC(2027, 2, 31, 1));
  });

  it('inactive maintenances have no current window but still report the next one', () => {
    const m = def({ strategy: 'cron', cron: '0 * * * *', durationS: 600, active: false });
    expect(currentWindow(m, Date.UTC(2026, 5, 1, 10, 5))).toBeNull();
    expect(maintenanceStatus(m, Date.UTC(2026, 5, 1, 10, 5))).toBe('inactive');
  });
});

describe('ancestors', () => {
  it('walks parents, cycle and depth safe', () => {
    const parents = new Map<number, number | null>([
      [1, 2],
      [2, 3],
      [3, null],
      [10, 11],
      [11, 10],
    ]);
    expect(withAncestors(1, (x) => parents.get(x))).toEqual([1, 2, 3]);
    expect(withAncestors(10, (x) => parents.get(x))).toEqual([10, 11]);
  });
});
