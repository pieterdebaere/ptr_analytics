// Which origin serves what (docs/SPEC.md §8.4, ANALYSIS §8.7.4):
//
// * dashboard host (PUBLIC_URL, or any host that is neither of the below): everything. With
//   STATUS_PAGE_ORIGIN set, `/status/:slug` (and its feed) redirect to that origin, so tenant
//   content (titles, Markdown, names, logos) never renders on the dashboard origin.
// * status host (STATUS_PAGE_ORIGIN) and verified custom domains: ONLY the public status
//   page surface — `/status/:slug`, its feed, `/` (custom domains: redirect to their page),
//   the SPA assets, `/api/public/*`, `/api/event` + `/script.js` (the page's own analytics),
//   `/favicon.svg`, `/healthz`. No login, no dashboard, no authenticated API: 404. A custom
//   domain only shows its own page.
//
// Decisions are made on the matched route pattern where there is one (the router decodes
// and normalises paths), on the raw path only for unrouted requests; default deny.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { AppContext } from '../../context.js';
import { isApiPath, pathOf } from '../../security.js';
import { normalizeHost } from './domains.js';
import { SLUG_RE } from './validate.js';

export type HostKind = { kind: 'dashboard' } | { kind: 'status-origin' } | { kind: 'custom'; slug: string | null };

const hostOf = (origin: string | null): string | null => (origin ? new URL(origin).hostname.toLowerCase() : null);

/** Startup warning: hosted mode should serve status pages on their own origin. */
export function statusOriginWarnings(config: Config): string[] {
  if (!config.cloud.signupEnabled || !config.uptime.enabled || config.statusPageOrigin !== null) return [];
  return [
    'Hosted mode without STATUS_PAGE_ORIGIN: public status pages (tenant-controlled titles, text and logos) are served ' +
      'on the dashboard origin. Set STATUS_PAGE_ORIGIN to a separate origin, e.g. https://status.example.com, and route ' +
      'it to this server.',
  ];
}

/** Classify the request's host (Host, or X-Forwarded-Host under TRUST_PROXY). */
export function classifyHost(ctx: AppContext, rawHost: string | undefined): HostKind {
  const h = normalizeHost(rawHost);
  if (h === null) return { kind: 'dashboard' };
  if (h === hostOf(ctx.config.statusPageOrigin)) return { kind: 'status-origin' };
  if (h === hostOf(ctx.config.publicUrl) || !ctx.config.uptime.enabled) return { kind: 'dashboard' };
  const r = ctx.db
    .prepare(
      `SELECT p.slug, p.published, p.deleted_at, s.deleted_at AS site_deleted FROM status_page_domains d
       JOIN status_pages p ON p.id = d.status_page_id
       JOIN sites s ON s.id = p.site_id
       WHERE d.domain = ? AND d.verified_at IS NOT NULL`,
    )
    .get(h) as { slug: string; published: number; deleted_at: number | null; site_deleted: number | null } | undefined;
  if (!r) return { kind: 'dashboard' };
  const live = r.published === 1 && r.deleted_at === null && r.site_deleted === null;
  return { kind: 'custom', slug: live ? r.slug : null };
}

const STATUS_PATH_RE = /^\/status\/([^/]+)$/;
const ASSET_PATH_RE = /^\/assets\/[A-Za-z0-9._-]+$/;
/** Routes served on status hosts as they are (besides `/api/public/*`). */
const STATUS_HOST_ROUTES = new Set(['/api/event', '/script.js', '/healthz']);

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (isApiPath(pathOf(request.url))) return reply.code(404).send({ error: 'not found' });
  return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
}

/** Slug a request addresses as a status page (`/status/:slug` or its feed), or null. */
function statusSlug(request: FastifyRequest): string | null {
  const route = request.routeOptions.url;
  if (route === '/status/:slug/feed.xml') {
    const slug = (request.params as { slug?: unknown }).slug;
    return typeof slug === 'string' ? slug : null;
  }
  // Unrouted, or the static-file wildcard (which falls through to the SPA's index.html).
  if (route !== undefined && route !== '/*') return null;
  const m = STATUS_PATH_RE.exec(pathOf(request.url));
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1] as string);
  } catch {
    return null;
  }
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * onRequest hook (registered at the root by routes/static.ts): enforce the host split.
 * Returns the reply when it answered the request itself.
 */
export async function enforceHostSplit(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const host = classifyHost(ctx, request.host);
  const read = request.method === 'GET' || request.method === 'HEAD';

  if (host.kind === 'dashboard') {
    const origin = ctx.config.statusPageOrigin;
    if (origin !== null && read && ctx.config.uptime.enabled && statusSlug(request) !== null) {
      // Public status pages live on their own origin; never render tenant content here.
      return reply.header('Cache-Control', 'no-store').redirect(`${origin}${request.url}`, 302);
    }
    return undefined;
  }

  const route = request.routeOptions.url;
  const path = pathOf(request.url);
  if (route !== undefined && route.startsWith('/api/public/')) return undefined;
  if (route !== undefined && STATUS_HOST_ROUTES.has(route)) return undefined;
  if (route === '/') {
    if (!read) return notFound(request, reply);
    // A verified custom domain shows its status page at the root. The answer depends on the
    // host (X-Forwarded-Host under TRUST_PROXY): never cached, and caches must key on it.
    if (host.kind === 'custom' && host.slug !== null) {
      return reply
        .header('Cache-Control', 'no-store')
        .header('Vary', 'Host, X-Forwarded-Host')
        .redirect(`/status/${encodeURIComponent(host.slug)}`, 302);
    }
    return notFound(request, reply);
  }
  if (read && route === '/*' && (ASSET_PATH_RE.test(path) || path === '/favicon.svg')) return undefined;
  const slug = read ? statusSlug(request) : null;
  if (slug !== null && (host.kind === 'status-origin' || slug === host.slug)) return undefined;
  return notFound(request, reply);
}
