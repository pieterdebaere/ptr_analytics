// STATUS_PAGE_ORIGIN / custom-domain host split (spec §8.4) and public cache invalidation.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig, ConfigError } from '../src/config.js';
import { statusOriginWarnings } from '../src/uptime/status/hosts.js';
import { validLabel } from '../src/uptime/status/badge.js';
import { ADMIN_PASSWORD, api, createCloudApp, createTestApp, login, type TestApp } from './helpers.js';
import { insertMonitor } from './uptime-status-fixtures.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const DASH = 'analytics.example.com';
const STATUS = 'status.example.com';

function get(app: FastifyInstance, url: string, host: string, extra: Partial<InjectOptions> = {}) {
  return app.inject({ method: 'GET', url, remoteAddress: '198.51.100.60', headers: { host, accept: 'text/html', ...(extra.headers as object) }, ...extra });
}

async function setup(env: Record<string, string> = {}): Promise<{ cookie: string; site: string; pageUid: string }> {
  t = await createTestApp({ env: { PUBLIC_URL: `https://${DASH}`, ...env } });
  const cookie = await login(t.app);
  const site = ((await api(t.app, cookie, 'POST', '/api/sites', { name: 'S', domains: ['s.example'] })).json() as { site: { id: string } }).site.id;
  const m = insertMonitor(t.ctx, site, { name: 'Web', status: 1 });
  const res = await api(t.app, cookie, 'POST', `/api/sites/${site}/status-pages`, {
    slug: 'acme',
    title: 'Acme',
    published: true,
    domains: ['status.acme.test'],
    sections: [{ name: 's', monitors: [{ uid: m.uid }] }],
  });
  expect(res.statusCode, res.body).toBe(201);
  const page = (res.json() as { statusPage: { uid: string } }).statusPage;
  // mark the custom domain verified (DNS is tested elsewhere)
  t.ctx.db.prepare('UPDATE status_page_domains SET verified_at = ?').run(t.clock.t);
  return { cookie, site, pageUid: page.uid };
}

describe('STATUS_PAGE_ORIGIN configuration', () => {
  it('is an origin on another host than PUBLIC_URL', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://a.example.com', STATUS_PAGE_ORIGIN: 'https://status.example.com/' }).statusPageOrigin).toBe(
      'https://status.example.com',
    );
    expect(loadConfig({}).statusPageOrigin).toBeNull();
    for (const bad of ['status.example.com', 'https://status.example.com/x', 'https://u:p@status.example.com', 'ftp://s.example.com']) {
      expect(() => loadConfig({ STATUS_PAGE_ORIGIN: bad }), bad).toThrow(ConfigError);
    }
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.com', STATUS_PAGE_ORIGIN: 'https://a.example.com:8443' })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.com', STATUS_PAGE_ORIGIN: 'https://s.a.example.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: 'https://a.example.com', STATUS_PAGE_ORIGIN: 'http://status.example.com' })).toThrow(ConfigError);
  });

  it('warns in hosted mode when it is not set', async () => {
    const c = await createCloudApp();
    t = c;
    expect(statusOriginWarnings(c.ctx.config)).toHaveLength(1);
    expect(statusOriginWarnings({ ...c.ctx.config, statusPageOrigin: `https://${STATUS}` })).toEqual([]);
    expect(statusOriginWarnings({ ...c.ctx.config, cloud: { ...c.ctx.config.cloud, signupEnabled: false } })).toEqual([]);
  });
});

describe('host split with STATUS_PAGE_ORIGIN', () => {
  it('redirects status pages from the dashboard origin', async () => {
    await setup({ STATUS_PAGE_ORIGIN: `https://${STATUS}` });
    const r = await get(t.app, '/status/acme?x=1', DASH);
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`https://${STATUS}/status/acme?x=1`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await get(t.app, '/status/acme/feed.xml', DASH)).headers.location).toBe(`https://${STATUS}/status/acme/feed.xml`);
    // the dashboard itself is untouched
    expect((await get(t.app, '/', DASH)).statusCode).toBe(200);
    expect((await get(t.app, '/login', DASH)).statusCode).toBe(200);
    // badges and the public JSON stay reachable for embeds
    expect((await get(t.app, '/api/public/status/acme', DASH)).statusCode).toBe(200);
    // the page JSON tells the dashboard where the page lives
    const pages = (await api(t.app, (await login(t.app)), 'GET', '/api/status-pages')).json() as { statusPages: Array<{ publicUrl: string }> };
    expect(pages.statusPages[0]?.publicUrl).toBe(`https://${STATUS}/status/acme`);
    expect((await t.app.inject({ method: 'GET', url: '/api/public-config' })).json()).toMatchObject({ statusPageOrigin: `https://${STATUS}` });
  });

  it('serves only the status page surface on the status origin', async () => {
    const { cookie } = await setup({ STATUS_PAGE_ORIGIN: `https://${STATUS}` });
    const page = await get(t.app, '/status/acme', STATUS);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect((await get(t.app, '/api/public/status/acme', STATUS)).statusCode).toBe(200);
    const feed = await get(t.app, '/status/acme/feed.xml', STATUS);
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain(`<link>https://${STATUS}/status/acme</link>`);
    expect((await get(t.app, '/assets/app-abc123.js', STATUS)).statusCode).toBe(200);
    expect((await get(t.app, '/favicon.svg', STATUS)).statusCode).toBe(200);
    expect((await get(t.app, '/script.js', STATUS)).statusCode).toBe(200);
    // nothing of the dashboard: no SPA routes, no login, no authenticated API (even with a cookie)
    for (const url of ['/', '/login', '/signup', '/settings/security', '/sites/x', '/uptime-bot', '/assets/../index.html', '/.env']) {
      const r = await get(t.app, url, STATUS);
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain('<div id="root">');
    }
    for (const url of ['/api/auth/me', '/api/sites', '/api/config', '/api/public-config', '/api/%61uth/me', '/metrics']) {
      const r = await t.app.inject({ method: 'GET', url, headers: { host: STATUS, cookie } });
      expect(r.statusCode, url).toBe(404);
    }
    const loginTry = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: STATUS, 'x-pa-request': '1' },
      payload: { email: 'admin@example.com', password: ADMIN_PASSWORD },
    });
    expect(loginTry.statusCode).toBe(404);
    expect(loginTry.headers['set-cookie']).toBeUndefined();
    // the page's own analytics still work
    const ev = await t.app.inject({ method: 'POST', url: '/api/event', headers: { host: STATUS, 'content-type': 'text/plain' }, payload: '{}' });
    expect(ev.statusCode).not.toBe(404);
  });
});

describe('custom domains', () => {
  it('only serve their own status page, also without STATUS_PAGE_ORIGIN', async () => {
    const { cookie, site } = await setup();
    const root = await get(t.app, '/', 'status.acme.test');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe('/status/acme');
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.headers.vary).toBe('Host, X-Forwarded-Host');
    expect((await get(t.app, '/status/acme', 'status.acme.test')).statusCode).toBe(200);
    expect((await get(t.app, '/api/public/status/acme', 'status.acme.test')).statusCode).toBe(200);
    // another tenant's page is not shown on this domain
    await api(t.app, cookie, 'POST', `/api/sites/${site}/status-pages`, { slug: 'other', title: 'O', published: true });
    expect((await get(t.app, '/status/other', 'status.acme.test')).statusCode).toBe(404);
    expect((await get(t.app, '/status/other/feed.xml', 'status.acme.test')).statusCode).toBe(404);
    for (const url of ['/login', '/settings', '/api/auth/me', '/api/sites']) {
      expect((await t.app.inject({ method: 'GET', url, headers: { host: 'status.acme.test', cookie, accept: 'text/html' } })).statusCode, url).toBe(404);
    }
    // the dashboard host still serves everything (and the page itself without STATUS_PAGE_ORIGIN)
    expect((await get(t.app, '/login', DASH)).statusCode).toBe(200);
    expect((await get(t.app, '/status/acme', DASH)).statusCode).toBe(200);
    // an unpublished page: the domain answers nothing
    const pageUid = (t.ctx.db.prepare("SELECT uid FROM status_pages WHERE slug = 'acme'").get() as { uid: string }).uid;
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${pageUid}`, { published: false });
    expect((await get(t.app, '/', 'status.acme.test')).statusCode).toBe(404);
    expect((await get(t.app, '/login', 'status.acme.test')).statusCode).toBe(404);
  });

  it('honours X-Forwarded-Host only under TRUST_PROXY, and the redirect is never cacheable', async () => {
    await setup({ TRUST_PROXY: 'true' });
    const r = await get(t.app, '/', DASH, { headers: { 'x-forwarded-host': 'status.acme.test' } });
    expect(r.statusCode).toBe(302);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.vary).toContain('X-Forwarded-Host');
  });

  it('cannot use the status origin host as a custom domain', async () => {
    const { pageUid, cookie } = await setup({ STATUS_PAGE_ORIGIN: `https://${STATUS}` });
    for (const d of [STATUS, `x.${STATUS}`]) {
      expect((await api(t.app, cookie, 'PATCH', `/api/status-pages/${pageUid}`, { domains: [d] })).statusCode, d).toBe(400);
    }
  });
});

describe('public caches', () => {
  it('stop serving a deleted site, a disabled badge and an unpublished page within seconds', async () => {
    const { cookie, site } = await setup();
    t.ctx.db.prepare("UPDATE monitors SET public_id = 'pubid-cache-12345'").run();
    const pub = (url: string) => get(t.app, url, DASH);
    expect((await pub('/api/public/badge/pubid-cache-12345/status.svg')).body).toContain('>up</text>');
    expect((await pub('/api/public/status/acme')).statusCode).toBe(200);
    // changed behind the API's back (e.g. badge disabled by another module): cached for < 5 s
    t.ctx.db.prepare('UPDATE monitors SET public_id = NULL').run();
    t.clock.t += 5_001;
    expect((await pub('/api/public/badge/pubid-cache-12345/status.svg')).body).toContain('N/A');
    expect((await api(t.app, cookie, 'DELETE', `/api/sites/${site}`)).statusCode).toBe(204);
    t.clock.t += 5_001;
    expect((await pub('/api/public/status/acme')).statusCode).toBe(404);
    expect((await pub('/api/public/status/acme/badge.svg')).body).toContain('N/A');
  });
});

describe('badge labels', () => {
  it('refuse characters XML cannot carry', () => {
    for (const bad of ['a￾b', 'a￿', '\uD800x', '﷐', 'a\u{1FFFF}', 'a\u0000']) expect(validLabel(bad), JSON.stringify(bad)).toBe(false);
    expect(validLabel('Uptime ✓ 日本 🙂')).toBe(true);
  });
});
