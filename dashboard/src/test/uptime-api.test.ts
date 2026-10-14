import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import {
  parseChannels,
  parseHeartbeats,
  parseMaintenance,
  parseMonitor,
  parseOverview,
  parseStats,
  parseStreamBeat,
  parseTypes,
  safeColor,
  statusName,
  toStatusCode,
  uptimeApi,
} from '../api/uptime';

function mockFetch(status: number, body?: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const MONITOR = {
  uid: 'k3j9x0abcd12',
  siteId: 'abc123def456',
  parentUid: null,
  type: 'http',
  name: 'Homepage',
  description: null,
  active: true,
  intervalS: 60,
  retryIntervalS: 30,
  maxRetries: 1,
  resendEvery: 0,
  timeoutMs: 10000,
  upsideDown: false,
  certNotify: true,
  domainNotify: false,
  config: { url: 'https://example.com/' },
  secretsSet: ['password'],
  target: 'https://example.com/',
  tags: [{ uid: 't1', name: 'prod', color: '#FF0000', value: 'eu' }, { uid: 't2', name: 'x', color: 'red;background:url(x)', value: '' }],
  channelUids: ['c1'],
  publicId: null,
  pushUrl: null,
  state: { status: 1, since: 1791000000000, lastCheckAt: 1791000060000, latencyMs: 123, msg: '200 OK' },
  uptime24h: 0.9998,
  uptime30d: 1.5,
  tls: { notAfter: 1796000000000, daysLeft: 61, issuer: "Let's Encrypt", valid: true, chain: [{ subject: 'CN=a', issuer: 'CN=b', notAfter: 1, fingerprint256: 'AA' }, 'junk'] },
  createdAt: 1,
  updatedAt: 2,
};

describe('uptime API parsing', () => {
  it('maps a Monitor and sanitises colours / ratios', () => {
    const m = parseMonitor(MONITOR)!;
    expect(m.uid).toBe('k3j9x0abcd12');
    expect(m.state).toEqual({ status: 1, since: 1791000000000, lastCheckAt: 1791000060000, latencyMs: 123, msg: '200 OK' });
    expect(m.tags[0]!.color).toBe('#ff0000');
    expect(m.tags[1]!.color).toBe('#64748b'); // invalid colour never reaches a style
    expect(m.uptime30d).toBe(1); // clamped
    expect(m.tls?.chain).toHaveLength(1);
    expect(m.secretsSet).toEqual(['password']);
    expect(m.domain).toBeNull();
  });

  it('tolerates missing / wrong members', () => {
    const m = parseMonitor({ uid: 'u1', state: { status: 'down' }, tags: 'x', intervalS: 'fast' })!;
    expect(m.state.status).toBe(0);
    expect(m.tags).toEqual([]);
    expect(m.intervalS).toBe(60);
    expect(m.tls).toBeNull();
    expect(parseMonitor({ name: 'no uid' })).toBeNull();
    expect(parseMonitor(null)).toBeNull();
  });

  it('maps statuses', () => {
    expect([-1, 0, 1, 2, 3, 9].map(statusName)).toEqual(['unknown', 'down', 'up', 'pending', 'maintenance', 'unknown']);
    expect(toStatusCode('maintenance')).toBe(3);
    expect(toStatusCode(7)).toBe(-1);
  });

  it('parses types with field definitions and limits', () => {
    const r = parseTypes({
      types: [
        {
          type: 'http',
          label: 'HTTP(S)',
          description: 'd',
          category: 'web',
          fields: [{ key: 'url', label: 'URL', kind: 'url', required: true }, { key: 'bad', kind: 'nope' }, { key: 'pw', label: 'PW', kind: 'password' }],
          defaults: { intervalS: 60 },
          available: true,
          hostedAllowed: true,
        },
        { label: 'no type' },
      ],
      limits: { minIntervalS: 60, maxTimeoutMs: 30000, maxRetries: 5, monitorsPerSite: 10 },
    });
    expect(r.types).toHaveLength(1);
    expect(r.types[0]!.fields.map((f) => f.key)).toEqual(['url', 'pw']);
    expect(r.types[0]!.fields[1]!.secret).toBe(true);
    expect(r.limits).toEqual({ minIntervalS: 60, maxTimeoutMs: 30000, maxRetries: 5, monitorsPerSite: 10 });
  });

  it('parses overview, heartbeats, stats, maintenance, channels and stream beats', () => {
    const o = parseOverview({ sites: [{ siteId: 's', total: 3, up: 2, down: 1, pending: 0, maintenance: 0, paused: 0, uptime30d: 0.99 }], monitors: [MONITOR] });
    expect(o.sites[0]!.down).toBe(1);
    expect(o.monitors).toHaveLength(1);
    const hb = parseHeartbeats({ interval: 'hour', points: [{ t: 2, status: 0, latencyMs: null, upRatio: 0.5 }, { t: 1, status: 1, latencyMs: 10 }, { status: 1 }] });
    expect(hb.interval).toBe('hour');
    expect(hb.points.map((p) => p.t)).toEqual([1, 2]);
    const st = parseStats({ uptime: 0.99, bars: [{ t: 1, upRatio: null, maintenance: true }] });
    expect(st.bars[0]).toEqual({ t: 1, upRatio: null, maintenance: true });
    expect(st.mttrMs).toBeNull();
    const mt = parseMaintenance({ uid: 'm1', title: 'T', strategy: 'monthly', daysOfMonth: [1, 'L', 40, 'x'], weekdays: [0, 7], status: 'under-maintenance', nextWindow: { start: 1, end: 2 } })!;
    expect(mt.daysOfMonth).toEqual([1, 'L']);
    expect(mt.weekdays).toEqual([0]);
    expect(mt.nextWindow).toEqual({ start: 1, end: 2 });
    expect(parseChannels({ channels: [{ uid: 'c1', name: 'Mail', type: 'email', isDefault: true }] })[0]!.isDefault).toBe(true);
    expect(parseStreamBeat({ uid: 'u', ts: 5, status: 0, latencyMs: null, msg: 'timeout' })).toEqual({ uid: 'u', ts: 5, status: 0, latencyMs: null, msg: 'timeout' });
    expect(parseStreamBeat({ uid: 'u' })).toBeNull();
    expect(safeColor('#ABCDEF')).toBe('#abcdef');
  });
});

describe('uptimeApi requests', () => {
  it('GETs the monitor and maps it', async () => {
    const fetch = mockFetch(200, { monitor: MONITOR });
    const m = await uptimeApi.getMonitor('k3j9x0abcd12');
    expect(m.name).toBe('Homepage');
    expect(fetch.mock.calls[0]![0]).toBe('/api/monitors/k3j9x0abcd12');
  });

  it('POSTs a new monitor to the site with the CSRF header', async () => {
    const fetch = mockFetch(201, { monitor: { ...MONITOR, type: 'push', pushUrl: 'https://a.test/api/push/tok' } });
    const m = await uptimeApi.createMonitor('abc123def456', { type: 'push', name: 'Cron' });
    expect(m.pushUrl).toBe('https://a.test/api/push/tok');
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('/api/sites/abc123def456/monitors');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-PA-Request']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ type: 'push', name: 'Cron' });
  });

  it('encodes ids and builds period queries', async () => {
    const fetch = mockFetch(200, { interval: 'raw', points: [] });
    await uptimeApi.heartbeats('a/b', { period: 'custom', from: '2026-01-01', to: '2026-01-31', tz: 'Europe/Brussels' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/monitors/a%2Fb/heartbeats?period=custom&tz=Europe%2FBrussels&from=2026-01-01&to=2026-01-31');
    mockFetch(200, { events: [] });
    await uptimeApi.events('u1', { before: 10, limit: 20 });
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe('/api/monitors/u1/events?before=10&limit=20');
  });

  it('treats an empty pause response as "no monitor body"', async () => {
    mockFetch(204);
    expect(await uptimeApi.pauseMonitor('u1')).toBeNull();
  });

  it('surfaces validation errors with their field', async () => {
    mockFetch(400, { error: 'Invalid URL', field: 'config.url' });
    const err = await uptimeApi.createMonitor('s1', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).field).toBe('config.url');
    expect((err as ApiError).message).toBe('Invalid URL');
  });

  it('reads limit errors', async () => {
    mockFetch(402, { error: 'Monitor limit reached', code: 'limit_reached' });
    const err = (await uptimeApi.createMonitor('s1', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('limit_reached');
  });
});
