import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIREFOX_MAC_UA, IPHONE_UA, MIN, createTestApp, pageview, sendEvent, type TestApp } from './helpers.js';

interface EventRow {
  type: string;
  name: string | null;
  visitor_id: string;
  session_id: string;
  hostname: string;
  path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  props: string | null;
}

let t: TestApp;
let siteId: string;

beforeEach(async () => {
  t = await createTestApp();
  siteId = t.ctx.sites.create('Example', ['example.com', '*.example.org', 'localhost'], t.clock.t).id;
});
afterEach(async () => {
  await t.app.close();
});

const events = (): EventRow[] => t.ctx.db.prepare('SELECT * FROM events ORDER BY id').all() as EventRow[];

describe('POST /api/event', () => {
  it('accepts a pageview sent as text/plain and stores only privacy-safe data', async () => {
    const res = await sendEvent(
      t.app,
      pageview(siteId, 'https://www.example.com/blog/post?utm_source=news&utm_medium=email&utm_campaign=launch&secret=1#frag', {
        referrer: 'https://www.google.com/search?q=private',
        width: 1280,
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
    const [e] = events();
    expect(e).toMatchObject({
      type: 'pageview',
      hostname: 'www.example.com',
      path: '/blog/post',
      referrer: 'google.com',
      utm_source: 'news',
      utm_medium: 'email',
      utm_campaign: 'launch',
      utm_term: null,
      browser: 'Chrome',
      os: 'Windows',
      device: 'desktop',
      props: null,
    });
    expect(e?.visitor_id).toMatch(/^[0-9a-f]{32}$/);
    // nothing in the DB contains the IP
    const dump = JSON.stringify(t.ctx.db.prepare('SELECT * FROM events').all());
    expect(dump).not.toContain('203.0.113.1');
    expect(dump).not.toContain('secret');
  });

  it('accepts application/json too and sets CORS headers', async () => {
    const res = await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { contentType: 'application/json' });
    expect(res.statusCode).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers CORS preflight', async () => {
    const res = await t.app.inject({ method: 'OPTIONS', url: '/api/event', headers: { origin: 'https://example.com' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('treats same-host referrers as internal and drops non-http referrers', async () => {
    await sendEvent(t.app, pageview(siteId, 'https://example.com/a', { referrer: 'https://www.example.com/b' }));
    await sendEvent(t.app, pageview(siteId, 'https://example.com/c', { referrer: 'android-app://com.foo' }));
    await sendEvent(t.app, pageview(siteId, 'https://example.com/d', { referrer: '' }));
    expect(events().map((e) => e.referrer)).toEqual([null, null, null]);
  });

  describe('domain matching', () => {
    const cases: Array<[string, number]> = [
      ['https://example.com/', 202],
      ['https://www.example.com/', 202],
      ['https://EXAMPLE.com./x', 202],
      ['https://example.com:8443/', 202],
      ['https://blog.example.com/', 400],
      ['https://example.org/', 202],
      ['https://a.b.example.org/', 202],
      ['https://notexample.org/', 400],
      ['https://example.org.evil.com/', 400],
      ['http://localhost:3000/', 202],
      ['https://evil.com/', 400],
    ];
    it.each(cases)('%s -> %i', async (url, status) => {
      const res = await sendEvent(t.app, pageview(siteId, url));
      expect(res.statusCode).toBe(status);
      if (status === 400) expect(res.json()).toEqual({ error: 'invalid payload' });
    });
  });

  it('rejects a mismatching Origin header but ignores "null"', async () => {
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { origin: 'https://evil.com' })).statusCode).toBe(400);
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { origin: 'https://www.example.com' })).statusCode).toBe(202);
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { origin: 'null' })).statusCode).toBe(202);
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { origin: 'garbage' })).statusCode).toBe(400);
  });

  it('rejects bad payloads with a generic 400', async () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { type: 'pageview', url: 'https://example.com/' },
      pageview('ABCDEFGHIJKL', 'https://example.com/'),
      pageview('zzzzzzzzzzzz', 'https://example.com/'), // unknown site
      pageview(siteId, 'ftp://example.com/'),
      pageview(siteId, '/relative'),
      pageview(siteId, `https://example.com/${'a'.repeat(2048)}`),
      { site: siteId, type: 'click', url: 'https://example.com/' },
      pageview(siteId, 'https://example.com/', { width: 1.5 }),
      pageview(siteId, 'https://example.com/', { width: -1 }),
      pageview(siteId, 'https://example.com/', { width: 100001 }),
      pageview(siteId, 'https://example.com/', { referrer: 42 }),
      { site: siteId, type: 'event', url: 'https://example.com/' },
      { site: siteId, type: 'event', url: 'https://example.com/', name: '   ' },
      { site: siteId, type: 'event', url: 'https://example.com/', name: 'a'.repeat(101) },
      { site: siteId, type: 'event', url: 'https://example.com/', name: 'bad\u0007name' },
      { site: siteId, type: 'vitals', url: 'https://example.com/' },
    ];
    for (const body of bad) {
      const res = await sendEvent(t.app, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid payload' });
    }
    expect(events()).toHaveLength(0);
  });

  it('rejects an empty JSON body and a too large body', async () => {
    const empty = await sendEvent(t.app, '', { contentType: 'application/json' });
    expect(empty.statusCode).toBe(400);
    const big = await sendEvent(t.app, pageview(siteId, 'https://example.com/', { pad: 'x'.repeat(9000) }));
    expect(big.statusCode).toBe(413);
  });

  it('rejects prototype pollution attempts', async () => {
    const proto = `{"site":"${siteId}","type":"event","url":"https://example.com/","name":"x","props":{"__proto__":{"admin":true}}}`;
    expect((await sendEvent(t.app, proto)).statusCode).toBe(400);
    const ctor = `{"site":"${siteId}","type":"event","url":"https://example.com/","name":"x","props":{"constructor":{"prototype":{"a":1}}}}`;
    expect((await sendEvent(t.app, ctor)).statusCode).toBe(400);
    const plain = { site: siteId, type: 'event', url: 'https://example.com/', name: 'x', props: { constructor: 'x' } };
    expect((await sendEvent(t.app, plain)).statusCode).toBe(400);
    const prototype = { site: siteId, type: 'event', url: 'https://example.com/', name: 'x', props: { prototype: 'x' } };
    expect((await sendEvent(t.app, prototype)).statusCode).toBe(400);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });

  it('validates and stores custom event props', async () => {
    const ok = await sendEvent(t.app, {
      site: siteId,
      type: 'event',
      url: 'https://example.com/pricing',
      name: '  Signup  ',
      props: { plan: 'pro', seats: 3, trial: false, coupon: null, note: 'x'.repeat(600) },
    });
    expect(ok.statusCode).toBe(202);
    const [e] = events();
    expect(e?.name).toBe('Signup');
    const props = JSON.parse(e?.props ?? '{}') as Record<string, unknown>;
    expect(props).toEqual({ plan: 'pro', seats: 3, trial: false, coupon: null, note: 'x'.repeat(500) });

    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 31; i++) tooMany[`k${i}`] = i;
    const invalidProps: unknown[] = [
      tooMany,
      { nested: { a: 1 } },
      { arr: [1, 2] },
      { ['k'.repeat(101)]: 1 },
      { '': 1 },
      'string',
      [1, 2],
    ];
    for (const props of invalidProps) {
      const res = await sendEvent(t.app, { site: siteId, type: 'event', url: 'https://example.com/', name: 'X', props });
      expect(res.statusCode).toBe(400);
    }
    // exactly 30 keys is fine
    const thirty: Record<string, number> = {};
    for (let i = 0; i < 30; i++) thirty[`k${i}`] = i;
    expect((await sendEvent(t.app, { site: siteId, type: 'event', url: 'https://example.com/', name: 'X', props: thirty })).statusCode).toBe(202);
  });

  it('validates and stores web vitals', async () => {
    const ok = await sendEvent(t.app, {
      site: siteId,
      type: 'vitals',
      url: 'https://example.com/landing?x=1',
      metrics: [
        { name: 'LCP', value: 1234.5 },
        { name: 'CLS', value: 0.12 },
        { name: 'INP', value: 0 },
      ],
    });
    expect(ok.statusCode).toBe(202);
    const rows = t.ctx.db.prepare('SELECT metric, value, path, device FROM vitals ORDER BY id').all();
    expect(rows).toEqual([
      { metric: 'LCP', value: 1234.5, path: '/landing', device: 'desktop' },
      { metric: 'CLS', value: 0.12, path: '/landing', device: 'desktop' },
      { metric: 'INP', value: 0, path: '/landing', device: 'desktop' },
    ]);
    expect(events()).toHaveLength(0);

    const bad: unknown[] = [
      [],
      [{ name: 'XYZ', value: 1 }],
      [{ name: 'LCP', value: -1 }],
      [{ name: 'LCP', value: 600001 }],
      [{ name: 'CLS', value: 101 }],
      [{ name: 'LCP', value: '1' }],
      [{ name: 'LCP', value: 1 }, { name: 'LCP', value: 2 }],
      [{ name: 'LCP', value: 1 }, { name: 'FCP', value: 1 }, { name: 'CLS', value: 1 }, { name: 'INP', value: 1 }, { name: 'TTFB', value: 1 }, { name: 'LCP', value: 1 }],
      'LCP',
    ];
    for (const metrics of bad) {
      const res = await sendEvent(t.app, { site: siteId, type: 'vitals', url: 'https://example.com/', metrics });
      expect(res.statusCode, JSON.stringify(metrics)).toBe(400);
    }
  });

  it('silently drops bots and empty user agents with 202', async () => {
    const bots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'curl/8.4.0',
      'python-requests/2.31',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'facebookexternalhit/1.1',
      '',
    ];
    for (const ua of bots) {
      const res = await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ua });
      expect(res.statusCode).toBe(202);
    }
    expect(events()).toHaveLength(0);
  });

  it('derives device from UA and falls back to width', async () => {
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ua: IPHONE_UA });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ua: FIREFOX_MAC_UA });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/', { width: 800 }), { ua: 'Mozilla/5.0 (Unknown) SomeBrowser/1.0' });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/', { width: 500 }), { ua: 'Mozilla/5.0 (Unknown) SomeBrowser/1.0' });
    expect(events().map((e) => [e.device, e.browser, e.os])).toEqual([
      ['mobile', 'Safari', 'iOS'],
      ['desktop', 'Firefox', 'macOS'],
      ['tablet', null, null],
      ['mobile', null, null],
    ]);
  });

  it('uses the trusted GEOIP_HEADER only when configured', async () => {
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers: { 'cf-ipcountry': 'DE' } });
    expect(events()[0]?.country).toBeNull();
    await t.app.close();

    t = await createTestApp({ env: { GEOIP_HEADER: 'CF-IPCountry' } });
    siteId = t.ctx.sites.create('Example', ['example.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers: { 'cf-ipcountry': 'de' } });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers: { 'cf-ipcountry': 'XX' } });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers: { 'cf-ipcountry': 'T1' } });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers: { 'cf-ipcountry': '<script>' } });
    expect(events().map((e) => e.country)).toEqual(['DE', null, null, null]);
  });

  it('rate limits per IP', async () => {
    await t.app.close();
    t = await createTestApp({ env: { INGEST_RATE_LIMIT: '3' } });
    siteId = t.ctx.sites.create('Example', ['example.com'], t.clock.t).id;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await sendEvent(t.app, pageview(siteId, 'https://example.com/'))).statusCode);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
    // another IP is unaffected
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ip: '198.51.100.7' })).statusCode).toBe(202);
    // window resets
    t.clock.t += 61_000;
    expect((await sendEvent(t.app, pageview(siteId, 'https://example.com/'))).statusCode).toBe(202);
  });
});

describe('visitors and sessions', () => {
  it('hashes visitors per day, site, IP and UA', async () => {
    const other = t.ctx.sites.create('Other', ['other.com'], t.clock.t).id;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'));
    await sendEvent(t.app, pageview(siteId, 'https://example.com/b'));
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ip: '203.0.113.2' });
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { ua: FIREFOX_MAC_UA });
    await sendEvent(t.app, pageview(other, 'https://other.com/'));
    const ids = events().map((e) => e.visitor_id);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);

    // next UTC day: new salt -> new visitor id, old salt deleted
    t.clock.t += 24 * 60 * MIN;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/'));
    const next = events().at(-1)?.visitor_id;
    expect(next).not.toBe(ids[0]);
    const salts = t.ctx.db.prepare('SELECT day FROM salts').all() as Array<{ day: string }>;
    expect(salts).toHaveLength(1);
    expect(salts[0]?.day).toBe(new Date(t.clock.t).toISOString().slice(0, 10));
  });

  it('groups events into 30-minute sessions and counts pageviews', async () => {
    await sendEvent(t.app, pageview(siteId, 'https://example.com/a'));
    t.clock.t += 10 * MIN;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/b'));
    t.clock.t += 5 * MIN;
    await sendEvent(t.app, { site: siteId, type: 'event', url: 'https://example.com/b', name: 'Click' });
    t.clock.t += 31 * MIN;
    await sendEvent(t.app, pageview(siteId, 'https://example.com/c'));

    const sessions = t.ctx.db.prepare('SELECT id, pageviews, started_at, last_seen_at FROM sessions ORDER BY started_at').all() as Array<{
      id: string;
      pageviews: number;
      started_at: number;
      last_seen_at: number;
    }>;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.pageviews).toBe(2);
    expect((sessions[0]?.last_seen_at ?? 0) - (sessions[0]?.started_at ?? 0)).toBe(15 * MIN);
    expect(sessions[1]?.pageviews).toBe(1);
    const e = events();
    expect(e[0]?.session_id).toBe(e[2]?.session_id);
    expect(e[3]?.session_id).not.toBe(e[0]?.session_id);
    expect(e.map((x) => x.session_id).every((s) => /^[0-9a-f]{32}$/.test(s))).toBe(true);
  });

  it('ignores cookies on /api/event (same-site beacons may carry the dashboard cookie)', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-pa-request': '1' },
      payload: { email: 'admin@example.com', password: 'correct horse battery' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    const headers = { cookie: `${cookie}; other=1; broken` };
    const a = await sendEvent(t.app, pageview(siteId, 'https://example.com/'), { headers });
    const b = await sendEvent(t.app, pageview(siteId, 'https://example.com/'));
    expect(a.statusCode).toBe(202);
    expect(a.headers['set-cookie']).toBeUndefined();
    const [x, y] = events();
    // identical visitor/session with or without the cookie: the cookie plays no role
    expect(x?.visitor_id).toBe(y?.visitor_id);
    expect(x?.session_id).toBe(y?.session_id);
  });
});
