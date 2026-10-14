import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMonitor, type Monitor } from '../api/uptime';
import { DaysBar, HeartbeatBar, type BeatLike } from '../components/uptime/bars';
import { appendBeat, applyBeat } from '../components/uptime/live';
import {
  countByStatus,
  displayStatus,
  filterMonitors,
  formatDurationMs,
  formatUptime,
  monitorTree,
  parentCandidates,
  safeTargetHref,
  siteHealthStatus,
  worstStatus,
} from '../components/uptime/lib';
import { MonitorList } from '../components/uptime/MonitorList';
import { monitorSuggestions } from '../components/uptime/onboarding';
import { maskPushUrl, pushExample } from '../components/uptime/push';
import { statusRanges } from '../components/uptime/ResponseTimeChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mon(p: Partial<Monitor> & { uid: string }, status = 1): Monitor {
  return parseMonitor({ siteId: 's1', type: 'http', name: p.uid, active: true, state: { status }, tags: [], ...p })!;
}

const LIST: Monitor[] = [
  mon({ uid: 'web', name: 'Website', target: 'https://example.com/', tags: [{ uid: 't1', name: 'prod', color: '#ff0000', value: '' }] }),
  mon({ uid: 'api', name: 'API', target: 'https://api.example.com/health', type: 'json' }, 0),
  mon({ uid: 'db', name: 'Database', target: 'db.internal:5432', type: 'postgres', siteId: 's2' }, 2),
  mon({ uid: 'grp', name: 'Backend', type: 'group' }),
  mon({ uid: 'cron', name: 'Nightly job', type: 'push', parentUid: 'grp', active: false }),
];

describe('uptime helpers', () => {
  it('derives display status, counts and worst status', () => {
    expect(LIST.map(displayStatus)).toEqual(['up', 'down', 'pending', 'up', 'paused']);
    const c = countByStatus(LIST);
    expect(c.up).toBe(2);
    expect(c.paused).toBe(1);
    expect(worstStatus(['up', 'maintenance', 'pending'])).toBe('pending');
    expect(worstStatus(['up', 'down'])).toBe('down');
    expect(siteHealthStatus({ total: 2, up: 0, down: 0, pending: 0, maintenance: 0, paused: 2 })).toBe('paused');
    expect(siteHealthStatus({ total: 3, up: 2, down: 1, pending: 0, maintenance: 0, paused: 0 })).toBe('down');
  });

  it('filters by search, status, site, tag and type', () => {
    expect(filterMonitors(LIST, { q: 'example' }).map((m) => m.uid)).toEqual(['web', 'api']);
    expect(filterMonitors(LIST, { q: 'api health' }).map((m) => m.uid)).toEqual(['api']);
    expect(filterMonitors(LIST, { q: 'PROD' }).map((m) => m.uid)).toEqual(['web']);
    expect(filterMonitors(LIST, { status: 'down' }).map((m) => m.uid)).toEqual(['api']);
    expect(filterMonitors(LIST, { status: 'paused' }).map((m) => m.uid)).toEqual(['cron']);
    expect(filterMonitors(LIST, { siteId: 's2' }).map((m) => m.uid)).toEqual(['db']);
    expect(filterMonitors(LIST, { tag: 't1' }).map((m) => m.uid)).toEqual(['web']);
    expect(filterMonitors(LIST, { type: 'postgres', q: '' }).map((m) => m.uid)).toEqual(['db']);
  });

  it('builds a group tree (down first, children under their group, cycles broken)', () => {
    const rows = monitorTree(LIST);
    expect(rows.map((r) => `${r.monitor.uid}:${r.depth}`)).toEqual(['api:0', 'grp:0', 'cron:1', 'db:0', 'web:0']);
    expect(rows.find((r) => r.monitor.uid === 'grp')!.childCount).toBe(1);
    expect(monitorTree(LIST, new Set(['grp'])).map((r) => r.monitor.uid)).not.toContain('cron');
    const cyc = [mon({ uid: 'a', parentUid: 'b' }), mon({ uid: 'b', parentUid: 'a' })];
    expect(monitorTree(cyc).map((r) => r.monitor.uid).sort()).toEqual(['a', 'b']);
  });

  it('offers only groups of the same site without cycles as parents', () => {
    const list = [mon({ uid: 'g1', type: 'group' }), mon({ uid: 'g2', type: 'group', parentUid: 'g1' }), mon({ uid: 'g3', type: 'group', siteId: 's2' })];
    expect(parentCandidates(list, 's1').map((m) => m.uid)).toEqual(['g1', 'g2']);
    expect(parentCandidates(list, 's1', 'g1').map((m) => m.uid)).toEqual([]);
  });

  it('formats uptime without rounding up to 100%', () => {
    expect(formatUptime(0.99999)).toBe('99.99%');
    expect(formatUptime(1)).toBe('100%');
    expect(formatUptime(null)).toBe('–');
    expect(formatDurationMs(3_725_000)).toBe('1h 2m');
    expect(formatDurationMs(90_061_000)).toBe('1d 1h');
  });

  it('links only to http(s) targets without credentials', () => {
    expect(safeTargetHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeTargetHref('javascript:alert(1)')).toBeNull();
    expect(safeTargetHref('https://user:pw@example.com/')).toBeNull();
    expect(safeTargetHref('db.internal:5432')).toBeNull();
    expect(safeTargetHref('ftp://x.test')).toBeNull();
  });

  it('applies stream beats and keeps the newest beats', () => {
    const m = applyBeat(LIST[0]!, { uid: 'web', ts: 1000, status: 0, latencyMs: null, msg: 'timeout' });
    expect(m.state).toMatchObject({ status: 0, since: 1000, lastCheckAt: 1000, msg: 'timeout' });
    expect(applyBeat(m, { uid: 'web', ts: 500, status: 1, latencyMs: 1, msg: '' })).toBe(m); // older beat ignored
    let beats: BeatLike[] = Array.from({ length: 50 }, (_, i) => ({ t: i, status: 1 as const }));
    beats = appendBeat(beats, { t: 100, status: 0 });
    expect(beats).toHaveLength(50);
    expect(beats[49]!.t).toBe(100);
    expect(appendBeat(beats, { t: 3, status: 1 })).toBe(beats);
  });

  it('computes down / maintenance ranges for the chart', () => {
    const pts = [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * 60_000, status: ([1, 0, 0, 1, 3, 1] as const)[i]!, latencyMs: 10, latencyMin: null, latencyMax: null, upRatio: null }));
    expect(statusRanges(pts, 'raw')).toEqual([
      { start: 60_000, end: 180_000, kind: 'down' },
      { start: 240_000, end: 300_000, kind: 'maintenance' },
    ]);
  });

  it('suggests https monitors for public, unmonitored domains', () => {
    const sites = [{ id: 's1', name: 'S', domains: ['example.com', '*.example.com', 'localhost', 'shop.example.com'], createdAt: 1 }];
    expect(monitorSuggestions(sites, [LIST[0]!]).map((s) => s.url)).toEqual(['https://shop.example.com/']);
  });

  it('masks push tokens and builds examples', () => {
    expect(maskPushUrl('https://a.test/api/push/abcdefghijkl')).toBe('https://a.test/api/push/abc•••••••••');
    expect(pushExample('curl', 'https://a.test/api/push/t', 60)).toBe('curl -fsS -m 10 --retry 3 "https://a.test/api/push/t?status=up&msg=OK&ping="');
    expect(pushExample('cron', 'U', 300)).toMatch(/^\*\/5 \* \* \* \* curl/);
  });
});

describe('HeartbeatBar', () => {
  it('renders empty slots, colour-coded beats and a text-only tooltip', () => {
    const beats = [
      { t: Date.UTC(2026, 0, 1, 10), status: 1 as const, latencyMs: 120, msg: 'OK' },
      { t: Date.UTC(2026, 0, 1, 10, 1), status: 0 as const, latencyMs: null, msg: '<img src=x onerror=alert(1)>' },
      { t: Date.UTC(2026, 0, 1, 10, 2), status: 3 as const, latencyMs: null, msg: null },
    ];
    act(() => root.render(<HeartbeatBar beats={beats} slots={10} />));
    const bar = container.querySelector('[role="group"]')!;
    const segs = bar.querySelectorAll('[aria-hidden="true"] > span');
    expect(segs).toHaveLength(10);
    expect(segs[0]!.className).toContain('bg-muted-foreground/12');
    expect(segs[7]!.className).toContain('bg-good');
    expect(segs[8]!.className).toContain('bg-poor');
    expect(segs[9]!.className).toContain('bg-maint');
    expect(bar.textContent).toContain('3 checks shown, 1 down');
    // keyboard: End selects the newest, ArrowLeft the down beat
    act(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')!.textContent).toContain('Maintenance');
    act(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    const tip = container.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toContain('Down');
    expect(tip.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    act(() => bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('shows only the newest `slots` beats', () => {
    const beats = Array.from({ length: 80 }, (_, i) => ({ t: i * 1000, status: (i === 79 ? 0 : 1) as 0 | 1 }));
    act(() => root.render(<HeartbeatBar beats={beats} slots={50} />));
    const segs = container.querySelectorAll('[aria-hidden="true"] > span');
    expect(segs).toHaveLength(50);
    expect(segs[49]!.className).toContain('bg-poor');
  });

  it('DaysBar colours days by uptime', () => {
    act(() => root.render(<DaysBar bars={[{ t: 0, upRatio: 1, maintenance: false }, { t: 1, upRatio: 0.9, maintenance: false }, { t: 2, upRatio: null, maintenance: true }, { t: 3, upRatio: null, maintenance: false }]} />));
    const segs = container.querySelectorAll('[aria-hidden="true"] > span');
    expect([...segs].map((s) => s.className.match(/bg-[a-z0-9-]+(\/\d+)?/)![0])).toEqual(['bg-good', 'bg-poor', 'bg-maint', 'bg-muted-foreground/20']);
  });
});

function Loc() {
  const l = useLocation();
  return <output data-testid="loc">{l.search}</output>;
}

describe('MonitorList', () => {
  const render = (url: string) =>
    act(() =>
      root.render(
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/uptime"
              element={
                <>
                  <MonitorList
                    monitors={[...LIST, mon({ uid: 'evil', name: '<b>x</b>‮gnp.exe', target: 'javascript:alert(1)' })]}
                    beats={new Map()}
                    sites={[
                      { id: 's1', name: 'Site one', domains: [], createdAt: 1 },
                      { id: 's2', name: 'Site two', domains: [], createdAt: 1 },
                    ]}
                    canManage
                    onChanged={() => {}}
                    onRemoved={() => {}}
                  />
                  <Loc />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      ),
    );

  it('renders rows as text with links to the detail page', () => {
    render('/uptime');
    const names = [...container.querySelectorAll('li a')].map((a) => a.textContent);
    expect(names).toContain('Website');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>�gnp.exe');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.every((h) => h?.startsWith('/monitors/'))).toBe(true);
    expect(container.textContent).toContain('Site two');
    expect(container.textContent).toContain('6 monitors');
  });

  it('filters from the URL and clears filters', () => {
    render('/uptime?status=down');
    expect([...container.querySelectorAll('li a')].map((a) => a.textContent)).toEqual(['API']);
    expect(container.textContent).toContain('1 of 6 monitors');
    const clear = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Clear')!;
    act(() => clear.click());
    expect(container.querySelector('[data-testid="loc"]')!.textContent).toBe('');
    expect(container.querySelectorAll('li a').length).toBe(6); // the group's child is listed under it
  });

  it('search box updates the query string', () => {
    render('/uptime');
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'data');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="loc"]')!.textContent).toBe('?q=data');
    expect([...container.querySelectorAll('li a')].map((a) => a.textContent)).toEqual(['Database']);
  });

  it('collapses groups', () => {
    render('/uptime');
    expect(container.textContent).toContain('Nightly job');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Collapse Backend"]')!.click());
    expect(container.textContent).not.toContain('Nightly job');
  });
});

describe('ui-audit fixes', () => {
  it('builds a header-based push example (token out of the URL)', () => {
    expect(pushExample('curl-header', 'https://a.test/api/push/tok123', 60)).toBe(
      'curl -fsS -m 10 --retry 3 -H "X-Push-Token: tok123" "https://a.test/api/push?status=up&msg=OK&ping="',
    );
    expect(pushExample('curl-header', '<PUSH_URL>', 60)).toContain('X-Push-Token: <PUSH_TOKEN>');
  });

  it('uses recentBeats from the API and merges newer local beats', async () => {
    const m = parseMonitor({ uid: 'a', siteId: 's', recentBeats: [{ t: 1, status: 1, latencyMs: 5 }, { t: 2, status: 'down', latencyMs: null }, { t: 'x' }] })!;
    expect(m.recentBeats).toEqual([
      { t: 1, status: 1, latencyMs: 5 },
      { t: 2, status: 0, latencyMs: null },
    ]);
    expect(parseMonitor({ uid: 'b' })!.recentBeats).toBeNull();
    const { mergeRecent } = await import('../components/uptime/live');
    expect(mergeRecent(m.recentBeats!, [{ t: 2, status: 0 }, { t: 3, status: 1 }]).map((b) => b.t)).toEqual([1, 2, 3]);
  });

  it('uses one uptime colour scheme for text and bars', async () => {
    const { uptimeTier, uptimeTone, dayClass } = await import('../components/uptime/lib');
    expect(uptimeTone(0.9995)).toBe('text-good-text');
    expect(uptimeTone(0.995)).toBe('text-good-text');
    expect(uptimeTone(0.97)).toBe('text-warn-text');
    expect(uptimeTone(0.5)).toBe('text-poor-text');
    expect(uptimeTone(null)).toBe('text-muted-foreground');
    expect(dayClass(0.995, false)).toBe(uptimeTier(0.995)!.bar);
  });

  it('normalises 24-hour times', async () => {
    const { normalizeTime24 } = await import('../components/uptime/form-parts');
    expect(normalizeTime24('2')).toBe('02:00');
    expect(normalizeTime24('230')).toBe('02:30');
    expect(normalizeTime24('0230')).toBe('02:30');
    expect(normalizeTime24('2:30')).toBe('02:30');
    expect(normalizeTime24('24:00')).toBe('24:00');
    expect(normalizeTime24('abc')).toBe('abc');
  });

  it('maps maintenance save errors to fields or the form', async () => {
    const { ApiError } = await import('../api/client');
    const { mapMaintenanceError } = await import('../components/uptime/maintenance-schedule');
    expect(mapMaintenanceError(new ApiError(400, 'Runs too often.', undefined, 'cron'))).toEqual({ errors: { cron: 'Runs too often.' }, form: null });
    expect(mapMaintenanceError(new ApiError(409, 'At most 20 cron windows.')).form).toBe('At most 20 cron windows.');
    expect(mapMaintenanceError(new ApiError(429, '')).form).toMatch(/try again/);
  });
});
