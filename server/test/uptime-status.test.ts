import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { txtLookup, statusPageForHost } from '../src/uptime/status/domains.js';
import { sniffImage } from '../src/uptime/status/image.js';
import { renderBadge, textWidth } from '../src/uptime/status/badge.js';
import { overallStatus } from '../src/uptime/status/render.js';
import { slugProblem } from '../src/uptime/status/validate.js';
import { api, cookieFrom, createCloudApp, createTestApp, DAY, HOUR, login, signupMember, type TestApp } from './helpers.js';
import { insertHour, insertMonitor, insertTag, insertTls } from './uptime-status-fixtures.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

async function createSite(app: FastifyInstance, cookie: string, name = 'Site'): Promise<string> {
  const res = await api(app, cookie, 'POST', '/api/sites', { name, domains: [`${name.toLowerCase().replace(/\W/g, '')}.example`] });
  expect(res.statusCode).toBe(201);
  return (res.json() as { site: { id: string } }).site.id;
}

interface PageJson {
  uid: string;
  slug: string;
  siteId: string;
  published: boolean;
  logoUrl: string | null;
  sections: Array<{ name: string; monitors: Array<{ uid: string; displayName: string | null; showUrl: boolean }> }>;
  domains: Array<{ domain: string; verified: boolean; verifyToken: string }>;
}

async function createPage(app: FastifyInstance, cookie: string, siteId: string, body: Record<string, unknown>): Promise<PageJson> {
  const res = await api(app, cookie, 'POST', `/api/sites/${siteId}/status-pages`, body);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { statusPage: PageJson }).statusPage;
}

function pub(app: FastifyInstance, url: string, extra: Partial<InjectOptions> = {}) {
  return app.inject({ method: 'GET', url, remoteAddress: '198.51.100.40', ...extra });
}

/* -------------------------------------------------------------------- units */

describe('slug rules', () => {
  it('accepts lowercase slugs and refuses reserved / malformed ones', () => {
    for (const ok of ['a', 'acme', 'acme-status', 'a1-b2', 'x'.repeat(64)]) expect(slugProblem(ok), ok).toBeNull();
    for (const bad of ['', '-a', 'a-', 'A', 'acme_status', 'a b', 'x'.repeat(65), 'é', 'a/b', '..', 'a.b']) expect(slugProblem(bad), bad).not.toBeNull();
    for (const reserved of ['api', 'admin', 'status', 'login', 'assets', 'metrics', 'uptime-bot']) {
      expect(slugProblem(reserved)).toBe('this slug is reserved');
    }
  });
});

describe('overall status', () => {
  it('combines monitor states', () => {
    expect(overallStatus([])).toBe('unknown');
    expect(overallStatus(['paused', 'unknown'])).toBe('unknown');
    expect(overallStatus(['up', 'up'])).toBe('up');
    expect(overallStatus(['up', 'down'])).toBe('degraded');
    expect(overallStatus(['up', 'pending'])).toBe('degraded');
    expect(overallStatus(['down', 'down', 'paused'])).toBe('down');
    expect(overallStatus(['up', 'maintenance'])).toBe('maintenance');
  });
});

/* -------------------------------------------------------------------- PNG */

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

function makePng(w = 2, h = 2, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra,
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeJpeg(w = 4, h = 3): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, sos, Buffer.from([0x12, 0x34, 0xff, 0xd9])]);
}

describe('logo sniffing', () => {
  it('accepts well-formed PNG / JPEG / WebP and refuses everything else', () => {
    expect(sniffImage(makePng())).toMatchObject({ mime: 'image/png', width: 2, height: 2 });
    expect(sniffImage(makeJpeg())).toMatchObject({ mime: 'image/jpeg', width: 4, height: 3 });
    const vp8l = Buffer.alloc(30);
    vp8l.write('RIFF', 0, 'latin1');
    vp8l.writeUInt32LE(22, 4);
    vp8l.write('WEBPVP8L', 8, 'latin1');
    vp8l[20] = 0x2f;
    vp8l.writeUInt32LE(9 | (4 << 14), 21);
    expect(sniffImage(vp8l)).toMatchObject({ mime: 'image/webp', width: 10, height: 5 });
    // SVG, HTML, polyglots, trailing data, absurd dimensions
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.concat([makePng(), Buffer.from('<html><script>alert(1)</script></html>')]))).toBeNull();
    expect(sniffImage(makePng(2, 2, [pngChunk('tEXt', Buffer.from('Comment\u0000<script>alert(1)</script>'))]))).toBeNull();
    expect(sniffImage(makePng(4096, 10))).toBeNull();
    expect(sniffImage(Buffer.concat([makeJpeg().subarray(0, -2), Buffer.from('<svg onload=alert(1)>'), Buffer.from([0xff, 0xd9])]))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });
});

/* -------------------------------------------------------------------- badges */

describe('badge renderer', () => {
  it('escapes all text and sizes by character widths', () => {
    const svg = renderBadge({ label: '</text><script>alert(1)</script>', message: 'up & "ok"', color: 'green', style: 'flat' });
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;/text&gt;&lt;script&gt;');
    expect(svg).toContain('up &amp; &quot;ok&quot;');
    expect(textWidth('WWW', 11)).toBeGreaterThan(textWidth('iii', 11));
    const short = renderBadge({ label: 'a', message: 'up', color: 'green', style: 'flat' });
    const long = renderBadge({ label: 'a much longer label', message: 'up', color: 'green', style: 'flat' });
    const width = (s: string): number => Number(/width="(\d+)"/.exec(s)?.[1]);
    expect(width(long)).toBeGreaterThan(width(short));
    // the colour only comes from the palette
    expect(renderBadge({ label: 'x', message: 'y', color: 'nope' as never, style: 'flat' })).toContain('#9f9f9f');
  });
});

/* ------------------------------------------------------------ API + public */

describe('status page API', () => {
  it('creates, reads, updates and deletes pages with ordered sections', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'Acme');
    const m1 = insertMonitor(t.ctx, site, { name: 'API' });
    const m2 = insertMonitor(t.ctx, site, { name: 'Web' });
    const page = await createPage(t.app, cookie, site, {
      slug: 'acme',
      title: 'Acme status',
      description: '**All** systems <b>go</b>',
      accent: '#1F6FEB',
      tz: 'Europe/Brussels',
      sections: [
        { name: 'Core', monitors: [{ uid: m2.uid, displayName: 'Website' }, { uid: m1.uid, showUrl: true }] },
        { name: 'Empty', monitors: [] },
      ],
    });
    expect(page).toMatchObject({
      slug: 'acme',
      siteId: site,
      published: false,
      sections: [
        { name: 'Core', monitors: [{ uid: m2.uid, displayName: 'Website', showUrl: false }, { uid: m1.uid, displayName: null, showUrl: true }] },
        { name: 'Empty', monitors: [] },
      ],
    });
    expect((page as unknown as { accent: string; tz: string; description: string }).accent).toBe('#1f6feb');
    // Markdown is stored as text, never rendered to HTML server-side
    expect((page as unknown as { description: string }).description).toBe('**All** systems <b>go</b>');
    const list = await api(t.app, cookie, 'GET', '/api/status-pages');
    expect((list.json() as { statusPages: PageJson[] }).statusPages.map((p) => p.uid)).toEqual([page.uid]);
    const patched = await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { title: 'New', published: true, sections: [] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ statusPage: { title: 'New', published: true, sections: [] } });
    expect((await api(t.app, cookie, 'DELETE', `/api/status-pages/${page.uid}`)).statusCode).toBe(204);
    expect((await api(t.app, cookie, 'GET', `/api/status-pages/${page.uid}`)).statusCode).toBe(404);
    // the slug is free again
    await createPage(t.app, cookie, site, { slug: 'acme', title: 'Again' });
  });

  it('validates slugs, uniqueness, fields and monitor ownership', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'One');
    const other = await createSite(t.app, cookie, 'Two');
    const foreign = insertMonitor(t.ctx, other);
    await createPage(t.app, cookie, site, { slug: 'taken', title: 'T' });
    const post = (body: Record<string, unknown>) => api(t.app, cookie, 'POST', `/api/sites/${site}/status-pages`, body);
    expect((await post({ slug: 'taken', title: 'T' })).statusCode).toBe(409);
    expect((await post({ slug: 'api', title: 'T' })).statusCode).toBe(400);
    expect((await post({ slug: 'Bad_Slug', title: 'T' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: '' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', description: 'x'.repeat(5001) })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', accent: 'red' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', accent: '#fff;background:url(x)' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', theme: 'neon' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', tz: 'Mars/Base' })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', refreshS: 1 })).statusCode).toBe(400);
    // monitors of another site are refused
    const cross = await post({ slug: 'ok-1', title: 'x', sections: [{ name: 's', monitors: [{ uid: foreign.uid }] }] });
    expect(cross.statusCode).toBe(400);
    const own = insertMonitor(t.ctx, site);
    expect((await post({ slug: 'ok-1', title: 'x', sections: [{ name: 's', monitors: [{ uid: own.uid }, { uid: own.uid }] }] })).statusCode).toBe(400);
    expect((await post({ slug: 'ok-1', title: 'x', sections: [{ name: 's', monitors: [{ uid: own.uid }] }] })).statusCode).toBe(201);
  });

  it('viewers read but never manage', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie);
    const page = await createPage(t.app, cookie, site, { slug: 'v', title: 'V' });
    await api(t.app, cookie, 'POST', '/api/users', { email: 'viewer@example.com', password: 'viewer password 1', role: 'viewer' });
    const viewer = await login(t.app, 'viewer@example.com', 'viewer password 1');
    expect((await api(t.app, viewer, 'GET', `/api/status-pages/${page.uid}`)).statusCode).toBe(200);
    expect((await api(t.app, viewer, 'PATCH', `/api/status-pages/${page.uid}`, { title: 'x' })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'POST', `/api/sites/${site}/status-pages`, { slug: 'w', title: 'W' })).statusCode).toBe(403);
    expect((await api(t.app, viewer, 'POST', `/api/status-pages/${page.uid}/incidents`, { title: 'x' })).statusCode).toBe(403);
  });
});

describe('hosted-mode tenancy', () => {
  it('isolates members and limits pages per site', async () => {
    const c = await createCloudApp();
    t = c;
    const a = await signupMember(c, 'a@example.org');
    const b = await signupMember(c, 'b@example.org');
    const siteA = await createSite(c.app, a.cookie, 'Alpha');
    const siteB = await createSite(c.app, b.cookie, 'Beta');
    const monA = insertMonitor(c.ctx, siteA);
    const page = await createPage(c.app, a.cookie, siteA, { slug: 'alpha', title: 'A' });
    // one page per site for members
    const second = await api(c.app, a.cookie, 'POST', `/api/sites/${siteA}/status-pages`, { slug: 'alpha-2', title: 'A2' });
    expect(second.statusCode).toBe(402);
    expect(second.json()).toMatchObject({ code: 'limit_reached' });
    // B can neither see nor touch A's page, nor create pages on A's site
    for (const [m, u] of [
      ['GET', `/api/status-pages/${page.uid}`],
      ['PATCH', `/api/status-pages/${page.uid}`],
      ['DELETE', `/api/status-pages/${page.uid}`],
      ['GET', `/api/status-pages/${page.uid}/incidents`],
      ['POST', `/api/status-pages/${page.uid}/incidents`],
    ] as const) {
      expect((await api(c.app, b.cookie, m, u, m === 'GET' || m === 'DELETE' ? undefined : { title: 'x' })).statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await api(c.app, b.cookie, 'POST', `/api/sites/${siteA}/status-pages`, { slug: 'evil', title: 'E' })).statusCode).toBe(404);
    expect((await api(c.app, b.cookie, 'GET', '/api/status-pages')).json()).toEqual({ statusPages: [] });
    // B cannot put A's monitor on its own page, nor link A's site for analytics
    expect(
      (await api(c.app, b.cookie, 'POST', `/api/sites/${siteB}/status-pages`, { slug: 'beta', title: 'B', sections: [{ name: 's', monitors: [{ uid: monA.uid }] }] })).statusCode,
    ).toBe(400);
    expect((await api(c.app, b.cookie, 'POST', `/api/sites/${siteB}/status-pages`, { slug: 'beta', title: 'B', analyticsSiteId: siteA })).statusCode).toBe(400);
    const incident = await api(c.app, a.cookie, 'POST', `/api/status-pages/${page.uid}/incidents`, { title: 'Down' });
    const incUid = (incident.json() as { incident: { uid: string } }).incident.uid;
    expect((await api(c.app, b.cookie, 'PATCH', `/api/incidents/${incUid}`, { title: 'pwned' })).statusCode).toBe(404);
    expect((await api(c.app, b.cookie, 'DELETE', `/api/incidents/${incUid}`)).statusCode).toBe(404);
  });
});

describe('public status page', () => {
  async function setup(): Promise<{ cookie: string; site: string; page: PageJson; up: { id: number; uid: string }; down: { id: number; uid: string } }> {
    t = await createTestApp({ env: { PUBLIC_URL: 'https://analytics.example.com' } });
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'Pub');
    const up = insertMonitor(t.ctx, site, { name: 'Website', status: 1, config: { url: 'https://user:pw@www.example.com/health' } });
    const down = insertMonitor(t.ctx, site, { name: 'Internal DB', status: 0, type: 'tcp', config: { host: '10.0.0.5', port: 5432 } });
    const page = await createPage(t.app, cookie, site, {
      slug: 'pub',
      title: 'Pub',
      published: true,
      sections: [{ name: 'All', monitors: [{ uid: up.uid, showUrl: true }, { uid: down.uid, displayName: 'Database', showUrl: true }] }],
    });
    return { cookie, site, page, up, down };
  }

  it('serves published pages only, with identical 404s', async () => {
    const { cookie, page } = await setup();
    const unknown = await pub(t.app, '/api/public/status/nope');
    expect(unknown.statusCode).toBe(404);
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { published: false });
    const unpublished = await pub(t.app, '/api/public/status/pub');
    expect(unpublished.statusCode).toBe(404);
    expect(unpublished.body).toBe(unknown.body);
    expect((await pub(t.app, '/api/public/status/API')).statusCode).toBe(404);
    // preview stays available to the owner
    expect((await api(t.app, cookie, 'GET', `/api/status-pages/${page.uid}/preview`)).json()).toMatchObject({ title: 'Pub' });
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { published: true });
    expect((await pub(t.app, '/api/public/status/pub')).statusCode).toBe(200);
  });

  it('exposes no internal ids, targets or messages', async () => {
    const { site, page, up, down } = await setup();
    const hour = Math.floor(t.clock.t / HOUR) * HOUR;
    insertHour(t.ctx, up.id, hour - 2 * HOUR, { up: 3_600_000 });
    insertHour(t.ctx, up.id, hour - 30 * HOUR, { up: 1_800_000, down: 1_800_000 });
    insertHour(t.ctx, down.id, hour - HOUR, { down: 3_600_000 });
    insertTls(t.ctx, up.id, t.clock.t + 20 * DAY);
    insertTag(t.ctx, up.id, 'prod');
    const res = await pub(t.app, '/api/public/status/pub');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      overall: string;
      analytics: unknown;
      paused: boolean;
      sections: Array<{ monitors: Array<Record<string, unknown> & { bars: Array<{ t: number; upRatio: number | null; maintenance: boolean }> }> }>;
    };
    const text = res.body;
    for (const secret of [site, page.uid, up.uid, down.uid, '10.0.0.5', 'secret check message', 'user:pw', 'internal.example.com', String(up.id)]) {
      expect(text, secret).not.toContain(`"${secret}`);
    }
    expect(text).not.toContain('user:pw');
    expect(text).not.toContain('10.0.0.5');
    expect(body.overall).toBe('degraded');
    expect(body.paused).toBe(false);
    expect(body.analytics).toBeNull();
    const [web, db] = body.sections[0]?.monitors ?? [];
    expect(web).toMatchObject({ name: 'Website', status: 'up', url: 'https://www.example.com/health' });
    expect(db).toMatchObject({ name: 'Database', status: 'down' });
    expect(db).not.toHaveProperty('url'); // tcp target never shown, even with showUrl
    expect(web?.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(web?.id).not.toBe(db?.id);
    expect(web).not.toHaveProperty('certDaysLeft');
    expect(web).not.toHaveProperty('tags');
    expect(web?.bars).toHaveLength(90);
    const bars = web?.bars ?? [];
    expect(bars[89]?.upRatio).toBe(1);
    expect(bars[88]?.upRatio).toBe(0.5);
    expect(bars[0]?.upRatio).toBeNull();
    expect(web?.uptime90d).toBeCloseTo(5_400_000 / 7_200_000);
    // security headers still apply to JSON
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });

  it('shows certificates and tags only when enabled, and analytics when linked', async () => {
    const { cookie, site, page, up } = await setup();
    insertTls(t.ctx, up.id, t.clock.t + 20 * DAY + 1000);
    insertTag(t.ctx, up.id, 'prod', 'eu');
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { showCertExpiry: true, showTags: true, analyticsSiteId: site });
    const body = (await pub(t.app, '/api/public/status/pub')).json() as {
      analytics: unknown;
      sections: Array<{ monitors: Array<Record<string, unknown>> }>;
    };
    expect(body.sections[0]?.monitors[0]).toMatchObject({ certDaysLeft: 20, tags: [{ name: 'prod', color: '#ff0000', value: 'eu' }] });
    expect(body.analytics).toEqual({ siteId: site, scriptUrl: '/script.js' });
  });

  it('hides deleted monitors, deleted sites and shows suspended sites as paused', async () => {
    const { cookie, site, down } = await setup();
    t.ctx.db.prepare('UPDATE monitors SET deleted_at = ? WHERE id = ?').run(t.clock.t, down.id);
    t.clock.t += 31_000; // public cache TTL
    const body = (await pub(t.app, '/api/public/status/pub')).json() as { overall: string; sections: Array<{ monitors: unknown[] }> };
    expect(body.sections[0]?.monitors).toHaveLength(1);
    expect(body.overall).toBe('up');
    t.ctx.db.prepare('UPDATE sites SET suspended = 1 WHERE id = ?').run(site);
    t.clock.t += 31_000;
    expect((await pub(t.app, '/api/public/status/pub')).json()).toMatchObject({ paused: true });
    expect((await api(t.app, cookie, 'DELETE', `/api/sites/${site}`)).statusCode).toBe(204);
    t.clock.t += 31_000;
    expect((await pub(t.app, '/api/public/status/pub')).statusCode).toBe(404);
  });

  it('lists incidents and maintenance', async () => {
    const { cookie, page } = await setup();
    const inc = await api(t.app, cookie, 'POST', `/api/status-pages/${page.uid}/incidents`, { title: 'Database outage', body: 'Investigating', style: 'danger' });
    expect(inc.statusCode).toBe(201);
    const incident = (inc.json() as { incident: { uid: string } }).incident;
    expect(inc.json()).toMatchObject({ incident: { title: 'Database outage', style: 'danger', pinned: true, resolvedAt: null } });
    t.ctx.db
      .prepare(`INSERT INTO maintenances (uid, owner_id, title, description, active, strategy, tz, created_at, updated_at) VALUES ('mnt000000001', NULL, 'Upgrade', 'DB upgrade', 1, 'manual', 'UTC', 0, 0)`)
      .run();
    const mid = (t.ctx.db.prepare('SELECT id FROM maintenances').get() as { id: number }).id;
    const pid = (t.ctx.db.prepare('SELECT id FROM status_pages').get() as { id: number }).id;
    t.ctx.db.prepare('INSERT INTO maintenance_status_pages (maintenance_id, status_page_id) VALUES (?, ?)').run(mid, pid);
    let body = (await pub(t.app, '/api/public/status/pub')).json() as { incidents: Array<Record<string, unknown>>; maintenance: unknown[] };
    expect(body.incidents).toHaveLength(1);
    expect(body.incidents[0]).toMatchObject({ title: 'Database outage', body: 'Investigating', style: 'danger', pinned: true });
    expect(body.maintenance).toEqual([{ title: 'Upgrade', description: 'DB upgrade', start: null, end: null, status: 'under-maintenance' }]);
    // a single window in two days, linked through a monitor of the page → scheduled
    const start = t.clock.t + 2 * DAY;
    t.ctx.db
      .prepare(
        `INSERT INTO maintenances (uid, owner_id, title, description, active, strategy, tz, starts_at, ends_at, created_at, updated_at)
         VALUES ('mnt000000002', NULL, 'Move', NULL, 1, 'single', 'UTC', ?, ?, 0, 0)`,
      )
      .run(start, start + HOUR);
    const mid2 = (t.ctx.db.prepare("SELECT id FROM maintenances WHERE uid = 'mnt000000002'").get() as { id: number }).id;
    const mon = (t.ctx.db.prepare("SELECT id FROM monitors WHERE name = 'Website'").get() as { id: number }).id;
    t.ctx.db.prepare('INSERT INTO maintenance_monitors (maintenance_id, monitor_id) VALUES (?, ?)').run(mid2, mon);
    // a window in 30 days is not listed yet
    t.ctx.db
      .prepare(
        `INSERT INTO maintenances (uid, owner_id, title, description, active, strategy, tz, starts_at, ends_at, created_at, updated_at)
         VALUES ('mnt000000003', NULL, 'Later', NULL, 1, 'single', 'UTC', ?, ?, 0, 0)`,
      )
      .run(t.clock.t + 30 * DAY, t.clock.t + 30 * DAY + HOUR);
    const mid3 = (t.ctx.db.prepare("SELECT id FROM maintenances WHERE uid = 'mnt000000003'").get() as { id: number }).id;
    t.ctx.db.prepare('INSERT INTO maintenance_status_pages (maintenance_id, status_page_id) VALUES (?, ?)').run(mid3, pid);
    t.clock.t += 31_000;
    body = (await pub(t.app, '/api/public/status/pub')).json() as typeof body;
    expect(body.maintenance).toEqual([
      { title: 'Upgrade', description: 'DB upgrade', start: null, end: null, status: 'under-maintenance' },
      { title: 'Move', description: null, start, end: start + HOUR, status: 'scheduled' },
    ]);
    const patched = await api(t.app, cookie, 'PATCH', `/api/incidents/${incident.uid}`, { resolved: true, pinned: false });
    expect(patched.json()).toMatchObject({ incident: { resolvedAt: t.clock.t, pinned: false } });
    body = (await pub(t.app, '/api/public/status/pub')).json() as typeof body;
    expect(body.incidents[0]).toMatchObject({ resolvedAt: t.clock.t });
    expect((await api(t.app, cookie, 'DELETE', `/api/incidents/${incident.uid}`)).statusCode).toBe(204);
    body = (await pub(t.app, '/api/public/status/pub')).json() as typeof body;
    expect(body.incidents).toHaveLength(0);
  });

  it('never shows a monitor of another site, even if linked in the database', async () => {
    const { cookie } = await setup();
    const otherSite = await createSite(t.app, cookie, 'Other');
    const foreign = insertMonitor(t.ctx, otherSite, { name: 'Foreign secret monitor' });
    const sec = (t.ctx.db.prepare('SELECT id FROM status_page_sections').get() as { id: number }).id;
    t.ctx.db.prepare('INSERT INTO status_page_monitors (section_id, monitor_id, position) VALUES (?, ?, 9)').run(sec, foreign.id);
    const res = await pub(t.app, '/api/public/status/pub');
    expect(res.body).not.toContain('Foreign secret monitor');
  });

  it('rate limits per IP', async () => {
    await setup();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await pub(t.app, '/api/public/status/pub', { remoteAddress: '192.0.2.200' })).statusCode;
    expect(last).toBe(429);
    expect((await pub(t.app, '/api/public/status/pub', { remoteAddress: '192.0.2.201' })).statusCode).toBe(200);
  });

  it('serves an XML-escaped RSS feed', async () => {
    const { cookie, page } = await setup();
    await api(t.app, cookie, 'POST', `/api/status-pages/${page.uid}/incidents`, { title: '<script>alert(1)</script> ]]> & co', body: '</description><evil/>' });
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { title: 'Acme <b>"Status"</b>' });
    const res = await pub(t.app, '/status/pub/feed.xml');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('<evil');
    expect(res.body).not.toContain('<b>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; ]]&gt; &amp; co');
    expect(res.body).toContain('<title>Acme &lt;b&gt;&quot;Status&quot;&lt;/b&gt;</title>');
    expect(res.body).toContain('<link>https://analytics.example.com/status/pub</link>');
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { published: false });
    expect((await pub(t.app, '/status/pub/feed.xml')).statusCode).toBe(404);
  });

  it('serves the uptime-bot page without user data', async () => {
    await setup();
    const res = await pub(t.app, '/uptime-bot');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.body).not.toContain('Website');
  });
});

describe('badges', () => {
  async function setup(): Promise<{ cookie: string; site: string }> {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'Bdg');
    const m = insertMonitor(t.ctx, site, { name: 'Web', status: 1, latencyMs: 87, publicId: 'pubid-ABC_123456' });
    insertHour(t.ctx, m.id, Math.floor(t.clock.t / HOUR) * HOUR - HOUR, { up: 3_598_000, down: 2_000 });
    insertTls(t.ctx, m.id, t.clock.t + 9 * DAY + 1);
    insertMonitor(t.ctx, site, { name: 'NoBadge', status: 0 });
    return { cookie, site };
  }

  it('renders monitor badges with strict parameters and safe headers', async () => {
    await setup();
    const res = await pub(t.app, '/api/public/badge/pubid-ABC_123456/status.svg?label=%3C%2Ftext%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).not.toContain('<script');
    expect(res.body).toContain('&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).toContain('>up</text>');
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/uptime.svg?period=24h')).body).toContain('99.94%');
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/response.svg')).body).toContain('87 ms');
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/cert.svg')).body).toContain('9 days');
    const big = await pub(t.app, '/api/public/badge/pubid-ABC_123456/status.svg?style=for-the-badge');
    expect(big.body).toContain('>UP</text>');
    // strict validation
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/status.svg?style=plastic')).statusCode).toBe(400);
    expect((await pub(t.app, `/api/public/badge/pubid-ABC_123456/status.svg?label=${'x'.repeat(65)}`)).statusCode).toBe(400);
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/status.svg?label=a%0Ab')).statusCode).toBe(400);
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/status.svg?label=a&label=b')).statusCode).toBe(400);
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/uptime.svg?period=1y')).statusCode).toBe(400);
    expect((await pub(t.app, '/api/public/badge/pubid-ABC_123456/ping.svg')).statusCode).toBe(404);
  });

  it('answers N/A for unknown ids and monitors without badges', async () => {
    await setup();
    const unknown = await pub(t.app, '/api/public/badge/doesnotexist1/status.svg');
    const malformed = await pub(t.app, '/api/public/badge/%3Cx%3E/status.svg');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain('N/A');
    expect(malformed.body).toBe(unknown.body);
  });

  it('renders the status page badge', async () => {
    const { cookie, site } = await setup();
    const m = (t.ctx.db.prepare("SELECT uid FROM monitors WHERE name = 'Web'").get() as { uid: string }).uid;
    await createPage(t.app, cookie, site, { slug: 'bdg', title: 'B', published: true, sections: [{ name: 's', monitors: [{ uid: m }] }] });
    const res = await pub(t.app, '/api/public/status/bdg/badge.svg?label=Acme');
    expect(res.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
    expect(res.body).toContain('operational');
    expect(res.body).toContain('Acme');
    expect((await pub(t.app, '/api/public/status/nope/badge.svg')).body).toContain('N/A');
  });
});

describe('logos', () => {
  it('stores sniffed raster logos and serves them with safe headers', async () => {
    t = await createTestApp();
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'Logo');
    const page = await createPage(t.app, cookie, site, { slug: 'logo', title: 'L' });
    const upload = (body: Buffer, type = 'image/png') =>
      t.app.inject({ method: 'POST', url: `/api/status-pages/${page.uid}/logo`, headers: { cookie, 'x-pa-request': '1', 'content-type': type }, payload: body });
    const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png');
    expect(svg.statusCode).toBe(400);
    const polyglot = await upload(Buffer.concat([makePng(), Buffer.from('<html><script>alert(1)</script>')]));
    expect(polyglot.statusCode).toBe(400);
    expect((await upload(Buffer.from('{}'), 'application/json')).statusCode).toBe(415);
    expect((await upload(Buffer.alloc(600 * 1024), 'image/png')).statusCode).toBe(413);
    const png = makePng();
    // declared type is ignored: the content decides
    const ok = await upload(png, 'image/jpeg');
    expect(ok.statusCode).toBe(200);
    const logoUrl = (ok.json() as { statusPage: { logoUrl: string } }).statusPage.logoUrl;
    expect(logoUrl).toMatch(/^\/api\/public\/assets\/[0-9a-f]{64}$/);
    const served = await pub(t.app, logoUrl);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain("default-src 'none'");
    expect(served.headers['content-disposition']).toBe('inline');
    expect(served.rawPayload.equals(png)).toBe(true);
    // replacing / removing the logo garbage-collects the old asset
    const del = await api(t.app, cookie, 'DELETE', `/api/status-pages/${page.uid}/logo`);
    expect(del.json()).toMatchObject({ statusPage: { logoUrl: null } });
    expect((await pub(t.app, logoUrl)).statusCode).toBe(404);
    expect((await pub(t.app, '/api/public/assets/..%2F..%2Fetc')).statusCode).toBe(404);
  });
});

describe('custom domains', () => {
  it('verifies via DNS TXT and maps verified hosts to published pages', async () => {
    t = await createTestApp({ env: { PUBLIC_URL: 'https://analytics.example.com' } });
    const cookie = await login(t.app);
    const site = await createSite(t.app, cookie, 'Dom');
    const page = await createPage(t.app, cookie, site, { slug: 'dom', title: 'D', published: true, domains: ['Status.Acme.test.'] });
    expect(page.domains).toEqual([{ domain: 'status.acme.test', verified: false, verifyToken: expect.stringMatching(/^ptr-status-verify=/), txtName: '_ptr-status.status.acme.test' }]);
    // invalid / forbidden domains
    for (const d of ['localhost', '10.0.0.1', 'analytics.example.com', 'x.analytics.example.com', 'nodot', 'a..b']) {
      expect((await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { domains: [d] })).statusCode, d).toBe(400);
    }
    // a domain belongs to one page only
    const other = await createPage(t.app, cookie, site, { slug: 'dom2', title: 'D2' });
    expect((await api(t.app, cookie, 'PATCH', `/api/status-pages/${other.uid}`, { domains: ['status.acme.test'] })).statusCode).toBe(409);

    expect(statusPageForHost(t.ctx, 'status.acme.test')).toBeNull();
    const original = txtLookup.resolve;
    const queried: string[] = [];
    try {
      txtLookup.resolve = async (name) => {
        queried.push(name);
        return ['unrelated', 'ptr-status-verify=wrong'];
      };
      const no = await api(t.app, cookie, 'POST', `/api/status-pages/${page.uid}/domains/verify`, { domain: 'status.acme.test' });
      expect(no.json()).toMatchObject({ domain: { verified: false } });
      txtLookup.resolve = async (name) => {
        queried.push(name);
        return [page.domains[0]?.verifyToken as string];
      };
      const yes = await api(t.app, cookie, 'POST', `/api/status-pages/${page.uid}/domains/verify`, { domain: 'status.acme.test' });
      expect(yes.json()).toMatchObject({ domain: { domain: 'status.acme.test', verified: true } });
    } finally {
      txtLookup.resolve = original;
    }
    expect(queried).toEqual(['_ptr-status.status.acme.test', '_ptr-status.status.acme.test']);
    expect(statusPageForHost(t.ctx, 'STATUS.acme.test:443')).toBe('dom');
    const host = await pub(t.app, '/api/public/status-host', { headers: { host: 'status.acme.test' } });
    expect(host.json()).toEqual({ slug: 'dom' });
    expect((await pub(t.app, '/api/public/status-host', { headers: { host: 'other.test' } })).json()).toEqual({ slug: null });
    expect((await pub(t.app, '/api/public/status-domain?domain=status.acme.test')).statusCode).toBe(200);
    expect((await pub(t.app, '/api/public/status-domain?domain=other.test')).statusCode).toBe(404);
    // unpublished pages are not served on their domain
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { published: false });
    expect(statusPageForHost(t.ctx, 'status.acme.test')).toBeNull();
    // keeping the domain keeps its verification; removing it drops it
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { published: true, domains: ['status.acme.test', 'www.acme.test'] });
    expect(statusPageForHost(t.ctx, 'status.acme.test')).toBe('dom');
    await api(t.app, cookie, 'PATCH', `/api/status-pages/${page.uid}`, { domains: [] });
    expect(statusPageForHost(t.ctx, 'status.acme.test')).toBeNull();
  });

  it('cookies are never set by public endpoints', async () => {
    t = await createTestApp();
    const res = await pub(t.app, '/api/public/status-host');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(cookieFrom).toBeTypeOf('function');
  });
});
