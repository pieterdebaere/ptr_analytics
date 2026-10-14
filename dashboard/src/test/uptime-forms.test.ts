import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Maintenance, MonitorTypeInfo } from '../api/uptime';
import {
  describeSchedule,
  draftFromMaintenance,
  draftToInput,
  emptyDraft,
  nextWindows,
  parseCron,
  validateMaintenance,
  zonedTimeToUtc,
  type MaintenanceDraft,
} from '../components/uptime/maintenance-schedule';
import { buildMonitorPayload, everyText, mapServerError, newMonitorForm, validateMonitorForm } from '../components/uptime/monitor-form';

const LIMITS = { minIntervalS: 60, maxTimeoutMs: 30_000, maxRetries: 5, monitorsPerSite: 10 };
const HTTP: MonitorTypeInfo = {
  type: 'http',
  label: 'HTTP(S)',
  description: '',
  category: 'web',
  fields: [
    { key: 'url', label: 'URL', kind: 'url', required: true },
    { key: 'password', label: 'Password', kind: 'password' },
  ],
  defaults: { intervalS: 30, timeoutMs: 48_000 },
  available: true,
  hostedAllowed: true,
};

describe('monitor form', () => {
  it('applies type defaults within the limits', () => {
    const f = newMonitorForm(HTTP, LIMITS, 's1');
    expect(f.intervalS).toBe(60); // raised to the minimum
    expect(f.timeoutS).toBe(30); // capped
    expect(f.certNotify).toBe(true);
    expect(f.siteId).toBe('s1');
  });

  it('validates common settings against the limits', () => {
    const f = { ...newMonitorForm(HTTP, LIMITS, ''), name: '', intervalS: 30, maxRetries: 9, timeoutS: 90 };
    const e = validateMonitorForm(f, 'http', LIMITS);
    expect(e.name).toBeDefined();
    expect(e.siteId).toBeDefined();
    expect(e.intervalS).toMatch(/At least 60/);
    expect(e.maxRetries).toMatch(/At most 5/);
    expect(e.timeoutS).toMatch(/At most 30/);
    const ok = { ...newMonitorForm(HTTP, LIMITS, 's1'), name: 'Home' };
    expect(validateMonitorForm(ok, 'http', LIMITS)).toEqual({});
    expect(validateMonitorForm({ ...ok, timeoutS: undefined }, 'push', LIMITS)).toEqual({}); // no timeout for push
    expect(validateMonitorForm({ ...ok, timeoutS: 50 }, 'http', { ...LIMITS, maxTimeoutMs: 120_000 }).timeoutS).toMatch(/80% of the check interval/);
    expect(validateMonitorForm({ ...ok, tags: [{ uid: 't', value: 'a' }, { uid: 't', value: 'a ' }] }, 'http', LIMITS).tags).toBeDefined();
  });

  it('builds the payload (ms timeout, secrets kept, type only on create)', () => {
    const f = { ...newMonitorForm(HTTP, LIMITS, 's1'), name: ' Home ', timeoutS: 12.5, parentUid: '', description: '  ' };
    const body = buildMonitorPayload(f, HTTP, { url: 'https://x.test', password: undefined }, { hosted: false, create: true });
    expect(body).toMatchObject({ name: 'Home', type: 'http', timeoutMs: 12_500, parentUid: null, description: null, config: { url: 'https://x.test' } });
    expect('password' in body.config!).toBe(false);
    const upd = buildMonitorPayload(f, HTTP, { url: 'https://x.test', password: null }, { hosted: false, create: false });
    expect(upd.type).toBeUndefined();
    expect(upd.config!.password).toBeNull();
    const push = buildMonitorPayload(f, { ...HTTP, type: 'push', fields: [] }, {}, { hosted: false, create: true });
    expect(push.timeoutMs).toBeUndefined();
    expect(push.certNotify).toBe(false);
  });

  it('maps server errors to fields', () => {
    expect(mapServerError(new ApiError(400, 'Invalid URL', undefined, 'config.url'), HTTP.fields, 'x').fields).toEqual({ url: 'Invalid URL' });
    expect(mapServerError(new ApiError(400, 'too short', undefined, 'intervalS'), HTTP.fields, 'x').common).toEqual({ intervalS: 'too short' });
    expect(mapServerError(new ApiError(400, 'url: must be https'), HTTP.fields, 'x').fields).toEqual({ url: 'must be https' });
    expect(mapServerError(new ApiError(400, 'timeoutMs: too long'), HTTP.fields, 'x').common).toEqual({ timeoutS: 'too long' });
    const other = mapServerError(new ApiError(402, 'Monitor limit reached'), HTTP.fields, 'x');
    expect(other.form).toBe('Monitor limit reached');
  });

  it('describes intervals', () => {
    expect(everyText(60)).toBe('every 1 min');
    expect(everyText(90)).toBe('every 1 min 30 s');
    expect(everyText(7200)).toBe('every 2 h');
  });
});

const BRU = 'Europe/Brussels';
const draft = (p: Partial<MaintenanceDraft>): MaintenanceDraft => ({ ...emptyDraft(BRU, Date.UTC(2026, 9, 14, 10)), title: 'T', ...p });

describe('maintenance schedule', () => {
  it('converts wall-clock times in a zone (DST aware)', () => {
    expect(zonedTimeToUtc(2026, 1, 15, 12, 0, BRU)).toBe(Date.UTC(2026, 0, 15, 11, 0)); // CET
    expect(zonedTimeToUtc(2026, 7, 15, 12, 0, BRU)).toBe(Date.UTC(2026, 6, 15, 10, 0)); // CEST
    expect(zonedTimeToUtc(2026, 7, 15, 12, 0, 'UTC')).toBe(Date.UTC(2026, 6, 15, 12, 0));
  });

  it('parses cron expressions', () => {
    const c = parseCron('*/15 2-3 L * MON,fri');
    expect(typeof c).toBe('object');
    if (typeof c === 'object') {
      expect([...c.minutes]).toEqual([0, 15, 30, 45]);
      expect([...c.hours]).toEqual([2, 3]);
      expect(c.lastDay).toBe(true);
      expect([...c.weekdays].sort()).toEqual([1, 5]);
    }
    const sun = parseCron('0 0 * * 7');
    expect(typeof sun === 'object' && [...sun.weekdays]).toEqual([0]);
    expect(parseCron('0 0 * *')).toMatch(/5 fields/);
    expect(parseCron('61 0 * * *')).toMatch(/Minute/);
    expect(parseCron('0 0 0 * *')).toMatch(/Day of month/);
  });

  it('validates each strategy', () => {
    expect(validateMaintenance(draft({ title: '' })).title).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'single', startLocal: '2026-10-20T10:00', endLocal: '2026-10-20T09:00' })).endLocal).toMatch(/after/);
    expect(validateMaintenance(draft({ strategy: 'weekly', weekdays: [] })).weekdays).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'weekly', startLocal: '', endLocal: '', timeStart: '25:00' })).timeStart).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'weekly', startLocal: '', endLocal: '', timeEnd: '02:00', timeStart: '02:00' })).timeEnd).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'monthly', daysOfMonth: [], startLocal: '', endLocal: '' })).daysOfMonth).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'interval', intervalDays: 0, startLocal: '' }))).toMatchObject({ intervalDays: expect.any(String), startLocal: expect.any(String) });
    expect(validateMaintenance(draft({ strategy: 'cron', cron: 'nope', durationMin: 0, startLocal: '', endLocal: '' }))).toMatchObject({ cron: expect.any(String), durationMin: expect.any(String) });
    expect(validateMaintenance(draft({ tz: 'Mars/Olympus' })).tz).toBeDefined();
    expect(validateMaintenance(draft({ strategy: 'manual' }))).toEqual({});
    expect(validateMaintenance(draft({ strategy: 'weekly', startLocal: '2026-10-20', endLocal: '2026-10-01' })).endLocal).toBeDefined();
  });

  it('computes the next windows for every strategy', () => {
    const now = Date.UTC(2026, 9, 14, 10); // Wed 14 Oct 2026, 12:00 in Brussels
    const weekly = nextWindows(draft({ strategy: 'weekly', weekdays: [0], timeStart: '02:00', timeEnd: '03:00', startLocal: '', endLocal: '' }), now);
    expect(weekly[0]).toEqual({ start: Date.UTC(2026, 9, 18, 0), end: Date.UTC(2026, 9, 18, 1) }); // Sun 02:00 CEST
    expect(weekly[1]!.start).toBe(Date.UTC(2026, 9, 25, 1)); // after DST ends: 02:00 CET
    const monthly = nextWindows(draft({ strategy: 'monthly', daysOfMonth: ['L'], timeStart: '23:00', timeEnd: '01:00', startLocal: '', endLocal: '' }), now, 2);
    expect(monthly.map((w) => new Date(w.start).toISOString())).toEqual(['2026-10-31T22:00:00.000Z', '2026-11-30T22:00:00.000Z']);
    expect(monthly[0]!.end - monthly[0]!.start).toBe(2 * 3_600_000); // crosses midnight
    const interval = nextWindows(draft({ strategy: 'interval', intervalDays: 3, startLocal: '2026-10-13', endLocal: '', timeStart: '04:00', timeEnd: '05:00' }), now);
    expect(interval.map((w) => new Date(w.start).toISOString().slice(0, 10))).toEqual(['2026-10-16', '2026-10-19', '2026-10-22']);
    const cron = nextWindows(draft({ strategy: 'cron', cron: '30 2 * * 0', durationMin: 90, startLocal: '', endLocal: '' }), now, 1);
    expect(cron).toEqual([{ start: Date.UTC(2026, 9, 18, 0, 30), end: Date.UTC(2026, 9, 18, 2, 0) }]);
    const single = nextWindows(draft({ strategy: 'single', startLocal: '2026-10-20T22:00', endLocal: '2026-10-21T01:00' }), now);
    expect(single).toEqual([{ start: Date.UTC(2026, 9, 20, 20), end: Date.UTC(2026, 9, 20, 23) }]);
    expect(nextWindows(draft({ strategy: 'single', startLocal: '2026-01-01T00:00', endLocal: '2026-01-02T00:00' }), now)).toEqual([]);
    expect(nextWindows(draft({ strategy: 'manual' }), now)).toEqual([]);
    // effective-until bound
    expect(nextWindows(draft({ strategy: 'weekly', weekdays: [0], startLocal: '', endLocal: '2026-10-20' }), now)).toHaveLength(1);
  });

  it('includes a window that is in progress', () => {
    const now = Date.UTC(2026, 9, 18, 0, 30); // Sun 02:30 Brussels
    const w = nextWindows(draft({ strategy: 'weekly', weekdays: [0], timeStart: '02:00', timeEnd: '03:00', startLocal: '', endLocal: '' }), now, 1);
    expect(w[0]!.start).toBeLessThan(now);
  });

  it('maps drafts to the API and back', () => {
    const d = draft({ strategy: 'monthly', daysOfMonth: ['L', 15, 1], timeStart: '01:00', timeEnd: '02:30', startLocal: '2026-11-01', endLocal: '2026-12-31', monitorUids: ['m1'] });
    const input = draftToInput(d);
    expect(input).toMatchObject({
      strategy: 'monthly',
      daysOfMonth: [1, 15, 'L'],
      weekdays: [],
      durationS: 5400,
      cron: null,
      timeStart: '01:00',
      startsAt: Date.UTC(2026, 9, 31, 23),
      endsAt: Date.UTC(2026, 11, 31, 23),
      monitorUids: ['m1'],
    });
    const back = draftFromMaintenance({ ...input, uid: 'x', status: 'scheduled', nextWindow: null } as Maintenance);
    expect(back.startLocal).toBe('2026-11-01');
    expect(back.endLocal).toBe('2026-12-31');
    expect(back.daysOfMonth).toEqual([1, 15, 'L']);
    expect(describeSchedule(input as Maintenance)).toBe('Monthly on day 1, 15, last · 01:00–02:30');
    const cron = draftToInput(draft({ strategy: 'cron', cron: ' 0  3 * * 1 ', durationMin: 30, startLocal: '', endLocal: '' }));
    expect(cron).toMatchObject({ cron: '0 3 * * 1', durationS: 1800, startsAt: null, endsAt: null, timeStart: null });
  });
});
