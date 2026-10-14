// Status pages, custom domains, logos and incidents — authenticated API (docs/SPEC.md §8.3).
// Tenancy follows the page's site (auth/access.ts): admin all, viewer read-only, member own
// sites; anything else is a 404 indistinguishable from "does not exist".
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { accessibleSites, assertSiteAccess, canAccessSite } from '../../auth/access.js';
import { currentUser, requireAuth } from '../../auth/guard.js';
import type { User } from '../../data/users.js';
import { field, isPlainObject, objectBody, type JsonObject } from '../../lib/body.js';
import { HttpError, badRequest, conflict, forbidden, notFound, tooMany } from '../../lib/errors.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { invalidatePublic } from './cache.js';
import { monitorIdsByUid } from './data.js';
import { domainTxtValues } from './domains.js';
import { MAX_LOGO_BYTES, sniffImage } from './image.js';
import { buildPublicStatus } from './render.js';
import {
  DOMAIN_CLAIM_TTL_MS,
  UID_RE,
  countIncidents,
  countPagesForSite,
  domainClaim,
  domainsOf,
  expireDomainClaims,
  gcAsset,
  getAsset,
  incidentByUid,
  incidentJson,
  incidentsOf,
  markDomainVerified,
  pageById,
  pageByUid,
  pagesForSites,
  putAsset,
  randomUid,
  replaceDomains,
  replaceSections,
  sectionsOf,
  slugTaken,
  verifiedClaim,
  type PageRow,
  type SectionInput,
} from './store.js';
import {
  accentField,
  boolField,
  incidentStyle,
  lineText,
  markdownText,
  normalizeStatusDomain,
  refreshField,
  slugProblem,
  themeField,
  tzField,
} from './validate.js';

const MAX_SECTIONS = 20;
const MAX_MONITORS_PER_SECTION = 100;
const MAX_MONITORS_PER_PAGE = 200;
const MAX_DOMAINS_MEMBER = 3;
const MAX_DOMAINS = 10;
const MAX_INCIDENTS_PER_PAGE = 500;

export interface StatusPageJson {
  uid: string;
  siteId: string;
  slug: string;
  title: string;
  description: string | null;
  footer: string | null;
  theme: string;
  accent: string | null;
  published: boolean;
  noindex: boolean;
  showTags: boolean;
  showCertExpiry: boolean;
  showPoweredBy: boolean;
  refreshS: number;
  tz: string;
  analyticsSiteId: string | null;
  /**
   * Logo for the dashboard (authenticated, works for unpublished pages); the public page
   * uses the public asset URL, served only while a published page uses the logo.
   */
  logoUrl: string | null;
  /** Path of the public page (`/status/<slug>`). */
  url: string;
  /** Absolute URL of the public page (STATUS_PAGE_ORIGIN, else PUBLIC_URL; the path when neither is set). */
  publicUrl: string;
  sections: Array<{ name: string; monitors: Array<{ uid: string; displayName: string | null; showUrl: boolean }> }>;
  /** `expiresAt`: unverified claims are dropped then (7 days after they were added). */
  domains: Array<{ domain: string; verified: boolean; verifyToken: string; txtName: string; expiresAt: number | null }>;
  createdAt: number;
  updatedAt: number;
}

/** Authenticated logo URL for the dashboard (versioned by content hash). */
export const dashboardLogoUrl = (p: Pick<PageRow, 'uid' | 'logo_asset'>): string | null =>
  p.logo_asset ? `/api/status-pages/${p.uid}/logo?v=${p.logo_asset.slice(0, 16)}` : null;

/** Absolute URL of a public status page. */
export function publicPageUrl(ctx: AppContext, slug: string): string {
  return `${ctx.config.statusPageOrigin ?? ctx.config.publicUrl ?? ''}/status/${slug}`;
}

export function statusPageJson(ctx: AppContext, p: PageRow): StatusPageJson {
  return {
    uid: p.uid,
    siteId: p.site_id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    footer: p.footer,
    theme: p.theme,
    accent: p.accent,
    published: p.published === 1,
    noindex: p.noindex === 1,
    showTags: p.show_tags === 1,
    showCertExpiry: p.show_cert_expiry === 1,
    showPoweredBy: p.show_powered_by === 1,
    refreshS: p.refresh_s,
    tz: p.tz,
    analyticsSiteId: p.analytics_site_id,
    logoUrl: dashboardLogoUrl(p),
    url: `/status/${p.slug}`,
    publicUrl: publicPageUrl(ctx, p.slug),
    sections: sectionsOf(ctx.db, p.id).map((s) => ({
      name: s.name,
      monitors: s.monitors.map((m) => ({ uid: m.uid, displayName: m.displayName, showUrl: m.showUrl })),
    })),
    domains: domainsOf(ctx.db, p.id).map((d) => ({
      domain: d.domain,
      verified: d.verified_at !== null,
      verifyToken: d.verify_token,
      txtName: `_ptr-status.${d.domain}`,
      expiresAt: d.verified_at === null ? d.created_at + DOMAIN_CLAIM_TTL_MS : null,
    })),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

type Access = 'read' | 'manage';

/** Load a page the user may access, or 404 (403 for a viewer trying to manage). */
function pageForUser(ctx: AppContext, user: User, uid: unknown, access: Access): PageRow {
  if (access === 'manage' && user.role === 'viewer') throw forbidden('admin role required');
  const page = typeof uid === 'string' ? pageByUid(ctx.db, uid) : null;
  const site = page ? ctx.sites.byId(page.site_id) : null;
  if (!page || !site || !canAccessSite(user, site, access)) throw notFound('status page not found');
  return page;
}

interface PageInput {
  slug?: string;
  title?: string;
  description?: string | null;
  footer?: string | null;
  theme?: string;
  accent?: string | null;
  published?: boolean;
  noindex?: boolean;
  showTags?: boolean;
  showCertExpiry?: boolean;
  showPoweredBy?: boolean;
  refreshS?: number;
  tz?: string;
  analyticsSiteId?: string | null;
  sections?: SectionInput[];
  domains?: string[];
}

function parseSections(ctx: AppContext, siteId: string, v: unknown): SectionInput[] {
  if (!Array.isArray(v) || v.length > MAX_SECTIONS) throw badRequest(`sections must be a list of at most ${MAX_SECTIONS} sections`);
  const raw = v.map((s, i) => {
    if (!isPlainObject(s)) throw badRequest('invalid section');
    const name = lineText(field(s, 'name'), `sections[${i}].name`, 100);
    const monitors = field(s, 'monitors') ?? [];
    if (!Array.isArray(monitors) || monitors.length > MAX_MONITORS_PER_SECTION) {
      throw badRequest(`a section holds at most ${MAX_MONITORS_PER_SECTION} monitors`);
    }
    return {
      name,
      monitors: monitors.map((m) => {
        if (!isPlainObject(m)) throw badRequest('invalid section monitor');
        const uid = field(m, 'uid');
        if (typeof uid !== 'string' || !UID_RE.test(uid)) throw badRequest('invalid monitor uid');
        const dn = field(m, 'displayName');
        const displayName = dn === undefined || dn === null || dn === '' ? null : lineText(dn, 'displayName', 100);
        const su = field(m, 'showUrl');
        return { uid, displayName, showUrl: su === undefined ? false : boolField(su, 'showUrl') };
      }),
    };
  });
  const uids = raw.flatMap((s) => s.monitors.map((m) => m.uid));
  if (uids.length > MAX_MONITORS_PER_PAGE) throw badRequest(`a status page holds at most ${MAX_MONITORS_PER_PAGE} monitors`);
  if (new Set(uids).size !== uids.length) throw badRequest('a monitor can only appear once on a status page');
  // Only monitors of the page's own site (same tenant, same billing unit).
  const ids = monitorIdsByUid(ctx.db, siteId, uids);
  for (const uid of uids) if (!ids.has(uid)) throw badRequest(`unknown monitor ${uid}`);
  return raw.map((s) => ({
    name: s.name,
    monitors: s.monitors.map((m) => ({ monitorId: ids.get(m.uid) as number, displayName: m.displayName, showUrl: m.showUrl })),
  }));
}

function parseDomains(ctx: AppContext, user: User, v: unknown): string[] {
  const max = user.role === 'member' ? MAX_DOMAINS_MEMBER : MAX_DOMAINS;
  if (!Array.isArray(v) || v.length > max) throw badRequest(`domains must be a list of at most ${max} domain names`);
  const list = v.map((d) => normalizeStatusDomain(d, ctx.config.publicUrl, ctx.config.statusPageOrigin));
  if (new Set(list).size !== list.length) throw badRequest('duplicate domain');
  return list;
}

function parsePageInput(ctx: AppContext, user: User, siteId: string, body: JsonObject, create: boolean): PageInput {
  const out: PageInput = {};
  const has = (k: string): boolean => field(body, k) !== undefined;
  if (create || has('slug')) {
    const slug = field(body, 'slug');
    const problem = slugProblem(slug);
    if (problem) throw badRequest(problem);
    out.slug = slug as string;
  }
  if (create || has('title')) out.title = lineText(field(body, 'title'), 'title', 100);
  if (has('description')) out.description = markdownText(field(body, 'description'), 'description');
  if (has('footer')) out.footer = markdownText(field(body, 'footer'), 'footer');
  if (has('theme')) out.theme = themeField(field(body, 'theme'));
  if (Object.hasOwn(body, 'accent')) out.accent = accentField(field(body, 'accent'));
  for (const k of ['published', 'noindex', 'showTags', 'showCertExpiry', 'showPoweredBy'] as const) {
    if (has(k)) out[k] = boolField(field(body, k), k);
  }
  if (has('refreshS')) out.refreshS = refreshField(field(body, 'refreshS'));
  if (has('tz')) out.tz = tzField(field(body, 'tz'));
  if (Object.hasOwn(body, 'analyticsSiteId')) {
    const a = field(body, 'analyticsSiteId');
    if (a === null) out.analyticsSiteId = null;
    else {
      // Must be a site this user can read (never another tenant's site).
      try {
        out.analyticsSiteId = assertSiteAccess(ctx, user, a, 'read').id;
      } catch (err) {
        if (err instanceof HttpError) throw badRequest('invalid analyticsSiteId');
        throw err;
      }
    }
  }
  if (has('sections')) out.sections = parseSections(ctx, siteId, field(body, 'sections'));
  if (has('domains')) out.domains = parseDomains(ctx, user, field(body, 'domains'));
  return out;
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT');

const bit = (b: boolean | undefined, current: number): number => (b === undefined ? current : b ? 1 : 0);

const domainLimiters = new WeakMap<AppContext, RateLimiter>();

export async function statusPageRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const db = ctx.db;
  const auth = requireAuth(ctx);
  let domainLimiter = domainLimiters.get(ctx);
  if (!domainLimiter) {
    domainLimiter = new RateLimiter(10, 60_000, ctx.now, 10_000);
    domainLimiters.set(ctx, domainLimiter);
  }
  const verifyLimiter = domainLimiter;

  // Raw logo uploads (only in this plugin's context); the content is sniffed, never trusted.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_LOGO_BYTES },
    (_request, body, done) => done(null, body),
  );

  const changed = (): void => invalidatePublic(ctx);
  /** Unverified domain claims expire (cheap; run before domain lists are read or changed). */
  const expireClaims = (): void => {
    expireDomainClaims(db, ctx.now());
  };

  app.get('/api/status-pages', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const sites = accessibleSites(ctx, user).map((s) => s.id);
    expireClaims();
    return { statusPages: pagesForSites(db, sites).map((p) => statusPageJson(ctx, p)) };
  });

  app.get<{ Params: { siteId: string } }>('/api/sites/:siteId/status-pages', { preHandler: auth }, async (request) => {
    const site = assertSiteAccess(ctx, request.user, request.params.siteId, 'read');
    expireClaims();
    return { statusPages: pagesForSites(db, [site.id]).map((p) => statusPageJson(ctx, p)) };
  });

  app.post<{ Params: { siteId: string } }>('/api/sites/:siteId/status-pages', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const site = assertSiteAccess(ctx, user, request.params.siteId, 'manage');
    const input = parsePageInput(ctx, user, site.id, objectBody(request.body), true);
    if (user.role === 'member' && countPagesForSite(db, site.id) >= ctx.config.uptime.memberStatusPagesPerSite) {
      throw new HttpError(402, 'status page limit reached for this site', 'limit_reached');
    }
    if (slugTaken(db, input.slug as string)) throw conflict('this slug is already taken');
    const now = ctx.now();
    let id: number;
    try {
      id = db.transaction(() => {
        const res = db
          .prepare(
            `INSERT INTO status_pages (uid, site_id, slug, title, description, footer, theme, accent, published, noindex,
               show_tags, show_cert_expiry, show_powered_by, refresh_s, tz, analytics_site_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUid(),
            site.id,
            input.slug,
            input.title,
            input.description ?? null,
            input.footer ?? null,
            input.theme ?? 'auto',
            input.accent ?? null,
            bit(input.published, 0),
            bit(input.noindex, 0),
            bit(input.showTags, 0),
            bit(input.showCertExpiry, 0),
            bit(input.showPoweredBy, 1),
            input.refreshS ?? 60,
            input.tz ?? 'UTC',
            input.analyticsSiteId ?? null,
            now,
            now,
          );
        const pageId = Number(res.lastInsertRowid);
        if (input.sections) replaceSections(db, pageId, input.sections);
        if (input.domains) replaceDomains(db, pageId, input.domains, now);
        return pageId;
      })();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('this slug is already taken');
      throw err;
    }
    changed();
    return reply.code(201).send({ statusPage: statusPageJson(ctx, pageById(db, id) as PageRow) });
  });

  app.get<{ Params: { uid: string } }>('/api/status-pages/:uid', { preHandler: auth }, async (request) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'read');
    expireClaims();
    return { statusPage: statusPageJson(ctx, page) };
  });

  /** The public JSON of the page whether or not it is published (dashboard preview). */
  app.get<{ Params: { uid: string } }>('/api/status-pages/:uid/preview', { preHandler: auth }, async (request) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'read');
    // The public logo URL only works while a published page uses the asset.
    return { ...buildPublicStatus(ctx, page), logoUrl: dashboardLogoUrl(page) };
  });

  app.patch<{ Params: { uid: string } }>('/api/status-pages/:uid', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const page = pageForUser(ctx, user, request.params.uid, 'manage');
    const input = parsePageInput(ctx, user, page.site_id, objectBody(request.body), false);
    if (input.slug !== undefined && input.slug !== page.slug && slugTaken(db, input.slug, page.id)) throw conflict('this slug is already taken');
    expireClaims();
    try {
      db.transaction(() => {
        db.prepare(
          `UPDATE status_pages SET slug = ?, title = ?, description = ?, footer = ?, theme = ?, accent = ?, published = ?,
             noindex = ?, show_tags = ?, show_cert_expiry = ?, show_powered_by = ?, refresh_s = ?, tz = ?,
             analytics_site_id = ?, updated_at = ? WHERE id = ?`,
        ).run(
          input.slug ?? page.slug,
          input.title ?? page.title,
          input.description !== undefined ? input.description : page.description,
          input.footer !== undefined ? input.footer : page.footer,
          input.theme ?? page.theme,
          input.accent !== undefined ? input.accent : page.accent,
          bit(input.published, page.published),
          bit(input.noindex, page.noindex),
          bit(input.showTags, page.show_tags),
          bit(input.showCertExpiry, page.show_cert_expiry),
          bit(input.showPoweredBy, page.show_powered_by),
          input.refreshS ?? page.refresh_s,
          input.tz ?? page.tz,
          input.analyticsSiteId !== undefined ? input.analyticsSiteId : page.analytics_site_id,
          ctx.now(),
          page.id,
        );
        if (input.sections) replaceSections(db, page.id, input.sections);
        if (input.domains) replaceDomains(db, page.id, input.domains, ctx.now());
      })();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('this slug is already taken');
      throw err;
    }
    changed();
    return { statusPage: statusPageJson(ctx, pageById(db, page.id) as PageRow) };
  });

  app.delete<{ Params: { uid: string } }>('/api/status-pages/:uid', { preHandler: auth }, async (request, reply) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'manage');
    // Small rows: sections, monitors, domains, incidents and maintenance links cascade.
    db.transaction(() => {
      db.prepare('DELETE FROM status_pages WHERE id = ?').run(page.id);
      gcAsset(db, page.logo_asset);
    })();
    changed();
    return reply.code(204).send();
  });

  /* --------------------------------------------------------------- logo */

  /** The page's logo for the dashboard (editor, preview), published or not. */
  const logoHeaders = async (_request: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    // Route-level onSend runs after the global security headers: the image gets its own CSP.
    if (reply.statusCode === 200) reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return payload;
  };

  app.get<{ Params: { uid: string } }>('/api/status-pages/:uid/logo', { preHandler: auth, onSend: logoHeaders }, async (request, reply) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'read');
    const asset = page.logo_asset ? getAsset(db, page.logo_asset) : null;
    if (!asset) throw notFound();
    return reply
      .code(200)
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=300')
      .type(asset.mime)
      .send(asset.bytes);
  });

  app.post<{ Params: { uid: string } }>(
    '/api/status-pages/:uid/logo',
    { preHandler: auth, bodyLimit: MAX_LOGO_BYTES },
    async (request: FastifyRequest<{ Params: { uid: string } }>) => {
      const user = currentUser(request);
      const page = pageForUser(ctx, user, request.params.uid, 'manage');
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw new HttpError(415, 'upload the image as the raw request body (PNG, JPEG or WebP)');
      const img = sniffImage(body);
      if (!img) throw badRequest('the logo must be a PNG, JPEG or WebP image of at most 512 KB and 2048×2048 pixels');
      const sha = createHash('sha256').update(body).digest('hex');
      const site = ctx.sites.byId(page.site_id);
      db.transaction(() => {
        putAsset(db, sha, site?.ownerId ?? null, img.mime, body, ctx.now());
        db.prepare('UPDATE status_pages SET logo_asset = ?, updated_at = ? WHERE id = ?').run(sha, ctx.now(), page.id);
        if (page.logo_asset !== sha) gcAsset(db, page.logo_asset);
      })();
      changed();
      return { statusPage: statusPageJson(ctx, pageById(db, page.id) as PageRow) };
    },
  );

  app.delete<{ Params: { uid: string } }>('/api/status-pages/:uid/logo', { preHandler: auth }, async (request) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'manage');
    db.transaction(() => {
      db.prepare('UPDATE status_pages SET logo_asset = NULL, updated_at = ? WHERE id = ?').run(ctx.now(), page.id);
      gcAsset(db, page.logo_asset);
    })();
    changed();
    return { statusPage: statusPageJson(ctx, pageById(db, page.id) as PageRow) };
  });

  /* ------------------------------------------------------------ domains */

  app.post<{ Params: { uid: string } }>('/api/status-pages/:uid/domains/verify', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    const page = pageForUser(ctx, user, request.params.uid, 'manage');
    const domain = normalizeStatusDomain(field(objectBody(request.body), 'domain'), ctx.config.publicUrl, ctx.config.statusPageOrigin);
    expireClaims();
    const claim = domainClaim(db, domain, page.id);
    if (!claim) throw notFound('domain not found on this status page');
    if (!verifyLimiter.hit(String(user.id))) throw tooMany('too many verification attempts, try again in a minute');
    const values = await domainTxtValues(domain);
    // The page or domain may have changed while DNS was queried; everything below is synchronous.
    const current = domainClaim(db, domain, page.id);
    if (!current || current.verify_token !== claim.verify_token) throw notFound('domain not found on this status page');
    if (current.verified_at === null && values.includes(current.verify_token)) {
      // First to verify wins: a page that verified earlier keeps the domain while its token is
      // still published (the DNS owner decides by removing it). Same answer either way.
      const holder = verifiedClaim(db, domain);
      if (!holder || holder.status_page_id === page.id || !values.includes(holder.verify_token)) {
        markDomainVerified(db, domain, page.id, ctx.now());
      }
    }
    changed();
    const after = domainClaim(db, domain, page.id);
    return {
      domain: {
        domain,
        verified: after?.verified_at != null,
        verifyToken: current.verify_token,
        txtName: `_ptr-status.${domain}`,
        expiresAt: after && after.verified_at === null ? after.created_at + DOMAIN_CLAIM_TTL_MS : null,
      },
    };
  });

  /* ---------------------------------------------------------- incidents */

  app.get<{ Params: { uid: string }; Querystring: { limit?: string } }>(
    '/api/status-pages/:uid/incidents',
    { preHandler: auth },
    async (request) => {
      const page = pageForUser(ctx, currentUser(request), request.params.uid, 'read');
      const raw = request.query.limit;
      let limit = 50;
      if (raw !== undefined) {
        if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 200) throw badRequest('invalid limit');
        limit = Number(raw);
      }
      return { incidents: incidentsOf(db, page.id, limit).map(incidentJson) };
    },
  );

  app.post<{ Params: { uid: string } }>('/api/status-pages/:uid/incidents', { preHandler: auth }, async (request, reply) => {
    const page = pageForUser(ctx, currentUser(request), request.params.uid, 'manage');
    const body = objectBody(request.body);
    const title = lineText(field(body, 'title'), 'title', 200);
    const text = markdownText(field(body, 'body') ?? '', 'body') ?? '';
    const style = field(body, 'style') === undefined ? 'info' : incidentStyle(field(body, 'style'));
    const pinned = field(body, 'pinned') === undefined ? true : boolField(field(body, 'pinned'), 'pinned');
    if (countIncidents(db, page.id) >= MAX_INCIDENTS_PER_PAGE) {
      throw new HttpError(409, 'too many incidents on this status page, delete old ones first', 'limit_reached');
    }
    const uid = randomUid();
    const now = ctx.now();
    db.prepare(
      `INSERT INTO incidents (uid, status_page_id, title, body, style, pinned, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(uid, page.id, title, text, style, pinned ? 1 : 0, now);
    changed();
    return reply.code(201).send({ incident: incidentJson(incidentByUid(db, uid) as NonNullable<ReturnType<typeof incidentByUid>>) });
  });

  const incidentForUser = (user: User, uid: string) => {
    if (user.role === 'viewer') throw forbidden('admin role required');
    const inc = incidentByUid(db, uid);
    const page = inc ? pageById(db, inc.status_page_id) : null;
    const site = page ? ctx.sites.byId(page.site_id) : null;
    if (!inc || !page || !site || !canAccessSite(user, site, 'manage')) throw notFound('incident not found');
    return inc;
  };

  app.patch<{ Params: { uid: string } }>('/api/incidents/:uid', { preHandler: auth }, async (request) => {
    const inc = incidentForUser(currentUser(request), request.params.uid);
    const body = objectBody(request.body);
    const title = field(body, 'title') === undefined ? inc.title : lineText(field(body, 'title'), 'title', 200);
    const text = field(body, 'body') === undefined ? inc.body : (markdownText(field(body, 'body'), 'body') ?? '');
    const style = field(body, 'style') === undefined ? inc.style : incidentStyle(field(body, 'style'));
    const pinned = field(body, 'pinned') === undefined ? inc.pinned === 1 : boolField(field(body, 'pinned'), 'pinned');
    const now = ctx.now();
    let resolvedAt = inc.resolved_at;
    if (field(body, 'resolved') !== undefined) {
      const resolved = boolField(field(body, 'resolved'), 'resolved');
      resolvedAt = resolved ? (inc.resolved_at ?? now) : null;
    }
    db.prepare('UPDATE incidents SET title = ?, body = ?, style = ?, pinned = ?, resolved_at = ?, updated_at = ? WHERE id = ?').run(
      title,
      text,
      style,
      pinned ? 1 : 0,
      resolvedAt,
      now,
      inc.id,
    );
    changed();
    return { incident: incidentJson(incidentByUid(db, inc.uid) as NonNullable<ReturnType<typeof incidentByUid>>) };
  });

  app.delete<{ Params: { uid: string } }>('/api/incidents/:uid', { preHandler: auth }, async (request, reply) => {
    const inc = incidentForUser(currentUser(request), request.params.uid);
    db.prepare('DELETE FROM incidents WHERE id = ?').run(inc.id);
    changed();
    return reply.code(204).send();
  });
}
