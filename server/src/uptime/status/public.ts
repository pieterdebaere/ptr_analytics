// Public, unauthenticated status endpoints (docs/SPEC.md §8.4): status page JSON, RSS feed,
// badges, uploaded logos, custom-domain lookups and the /uptime-bot info page.
//
// * Unknown and unpublished pages answer the identical 404; badges of unknown/disabled ids
//   render the same grey "N/A" badge (no existence oracle).
// * Per-IP rate limits on every endpoint, short in-memory caches (status JSON 30 s, badges
//   60 s) so a flood of requests costs little database work. Entries older than 5 s are
//   re-validated with one indexed lookup (deleted site, unpublished page, disabled badge).
// * Logos are only served while a published page uses them (no upload oracle, nothing of
//   unpublished pages); the dashboard reads them through the authenticated API.
// * The global security headers (CSP, nosniff, CORP same-origin, …) apply to everything;
//   badge SVGs and logo images override exactly the headers they need in this plugin's
//   onSend hook (which runs after the global one).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { clientIp, rateLimitKey } from '../../lib/client-ip.js';
import { HttpError, badRequest, notFound, tooMany } from '../../lib/errors.js';
import type { RateLimiter } from '../../lib/rate-limit.js';
import { BADGE_STYLES, formatPercent, renderBadge, uptimeColor, validLabel, type BadgeColor, type BadgeStyle } from './badge.js';
import { REVALIDATE_MS, publicState, type Checked, type TtlCache } from './cache.js';
import { certDaysLeft, monitorByPublicId, monitorIdByPublicId, uptimeRatios } from './data.js';
import { statusPageForHost } from './domains.js';
import { buildPublicStatus, type PublicStatus } from './render.js';
import { buildFeed } from './rss.js';
import { assetPublished, getAsset, pageBySlug, pageFingerprint } from './store.js';
import { SLUG_RE, normalizeStatusDomain } from './validate.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

export { statusPageForHost } from './domains.js';

const BADGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const ASSET_CSP = "default-src 'none'; sandbox";
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BADGE_FILES = new Set(['status.svg', 'uptime.svg', 'response.svg', 'cert.svg']);
const UPTIME_PERIODS: Record<string, number> = { '24h': 24 * HOUR, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY };

/** Headers that must win over the global security headers for one reply. */
const overrides = new WeakMap<FastifyReply, Record<string, string>>();

function override(reply: FastifyReply, headers: Record<string, string>): void {
  overrides.set(reply, { ...overrides.get(reply), ...headers });
}

function limit(request: FastifyRequest, limiter: RateLimiter): void {
  if (!limiter.hit(rateLimitKey(clientIp(request)))) throw tooMany();
}

function queryParam(request: FastifyRequest, key: string): string | undefined {
  const q = request.query as Record<string, unknown>;
  const v = Object.hasOwn(q, key) ? q[key] : undefined;
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badRequest(`invalid ${key}`);
  return v;
}

interface BadgeParams {
  style: BadgeStyle;
  label: string | undefined;
}

function badgeParams(request: FastifyRequest): BadgeParams {
  const style = queryParam(request, 'style') ?? 'flat';
  if (!(BADGE_STYLES as readonly string[]).includes(style)) throw badRequest('style must be flat, flat-square or for-the-badge');
  const label = queryParam(request, 'label');
  if (label !== undefined && !validLabel(label)) throw badRequest('label must be at most 64 characters without control characters');
  return { style: style as BadgeStyle, label };
}

export async function publicStatusRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const db = ctx.db;
  const state = publicState(ctx);

  app.addHook('onSend', async (_request, reply, payload) => {
    const h = overrides.get(reply);
    if (h) for (const [k, v] of Object.entries(h)) reply.header(k, v);
    return payload;
  });

  /**
   * Cached value, re-validated when older than REVALIDATE_MS: `fingerprint()` describes what
   * the value was rendered for; a different answer drops the entry.
   */
  function revalidated<V>(cache: TtlCache<Checked<V>>, key: string, fingerprint: () => string): V | undefined {
    const hit = cache.get(key);
    if (!hit) return undefined;
    const now = ctx.now();
    if (now - hit.checkedAt < REVALIDATE_MS) return hit.value;
    if (fingerprint() !== hit.fingerprint) {
      cache.delete(key);
      return undefined;
    }
    hit.checkedAt = now;
    return hit.value;
  }

  const pageFp = (slug: string): string => pageFingerprint(db, slug) ?? '-';

  /** Public JSON of a published page (cached), or null. */
  const publicPage = (slug: string): PublicStatus | null => {
    if (!SLUG_RE.test(slug)) return null;
    const cached = revalidated(state.pages, slug, () => pageFp(slug)) as PublicStatus | undefined;
    if (cached) return cached;
    const fingerprint = pageFp(slug);
    const page = pageBySlug(db, slug);
    if (!page || page.published !== 1) return null;
    const out = buildPublicStatus(ctx, page);
    state.pages.set(slug, { value: out, fingerprint, checkedAt: ctx.now() });
    return out;
  };

  app.get<{ Params: { slug: string } }>('/api/public/status/:slug', async (request, reply) => {
    limit(request, state.limits.status);
    const out = publicPage(request.params.slug);
    if (!out) throw notFound();
    reply.header('Cache-Control', 'public, max-age=30');
    if (out.noindex) reply.header('X-Robots-Tag', 'noindex');
    return out;
  });

  /* ------------------------------------------------------------- badges */

  const sendBadge = (reply: FastifyReply, svg: string): FastifyReply => {
    override(reply, {
      'Content-Security-Policy': BADGE_CSP,
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    });
    return reply.code(200).type('image/svg+xml; charset=utf-8').send(svg);
  };

  /** Badge SVG from the cache (re-validated with `fingerprint`) or freshly rendered. */
  const cachedBadge = (key: string, fingerprint: () => string, render: () => string): string => {
    const hit = revalidated(state.badges, key, fingerprint);
    if (hit !== undefined) return hit;
    const fp = fingerprint();
    const svg = render();
    state.badges.set(key, { value: svg, fingerprint: fp, checkedAt: ctx.now() });
    return svg;
  };

  const na = (p: BadgeParams, fallbackLabel: string): string =>
    renderBadge({ label: p.label ?? fallbackLabel, message: 'N/A', color: 'grey', style: p.style });

  app.get<{ Params: { publicId: string; file: string } }>('/api/public/badge/:publicId/:file', async (request, reply) => {
    limit(request, state.limits.badge);
    const { publicId, file } = request.params;
    if (!BADGE_FILES.has(file)) throw notFound();
    const kind = file.slice(0, -4) as 'status' | 'uptime' | 'response' | 'cert';
    const p = badgeParams(request);
    let periodKey = '';
    if (kind === 'uptime') {
      periodKey = queryParam(request, 'period') ?? '24h';
      if (!Object.hasOwn(UPTIME_PERIODS, periodKey)) throw badRequest('period must be 24h, 7d, 30d or 90d');
    }
    const defaults: Record<typeof kind, string> = {
      status: 'status',
      uptime: `uptime (${periodKey})`,
      response: 'response',
      cert: 'certificate',
    };
    const key = `${kind}\n${publicId}\n${periodKey}\n${p.style}\n${p.label ?? '\u0000'}`;
    // Malformed ids: the static N/A badge, no database work at all.
    if (!PUBLIC_ID_RE.test(publicId)) return sendBadge(reply, na(p, defaults[kind]));
    const badgeFp = (): string => String(monitorIdByPublicId(db, publicId));
    const svg = cachedBadge(key, badgeFp, () => {
      const m = monitorByPublicId(db, publicId);
      if (!m) return na(p, defaults[kind]);
      const label = p.label ?? defaults[kind];
      const paused = !m.active || m.siteSuspended;
      const badge = (message: string, color: BadgeColor): string => renderBadge({ label, message, color, style: p.style });
      const now = ctx.now();
      switch (kind) {
        case 'status': {
          if (paused) return badge('paused', 'grey');
          const map: Record<number, [string, BadgeColor]> = {
            0: ['down', 'red'],
            1: ['up', 'green'],
            2: ['pending', 'yellow'],
            3: ['maintenance', 'maintenance'],
          };
          const [msg, color] = map[m.status] ?? ['unknown', 'grey'];
          return badge(msg, color);
        }
        case 'uptime': {
          const ratio = uptimeRatios(db, [m.id], now - (UPTIME_PERIODS[periodKey] as number)).get(m.id) ?? null;
          return ratio === null ? badge('N/A', 'grey') : badge(formatPercent(ratio), paused ? 'grey' : uptimeColor(ratio));
        }
        case 'response':
          return m.latencyMs === null || paused || m.status !== 1 ? badge('N/A', 'grey') : badge(`${Math.round(m.latencyMs)} ms`, 'blue');
        case 'cert': {
          const days = certDaysLeft(db, [m.id], now).get(m.id);
          if (days === undefined) return badge('N/A', 'grey');
          if (days < 0) return badge('expired', 'red');
          return badge(`${days} ${days === 1 ? 'day' : 'days'}`, paused ? 'grey' : days < 7 ? 'red' : days < 14 ? 'yellow' : 'green');
        }
      }
    });
    return sendBadge(reply, svg);
  });

  app.get<{ Params: { slug: string } }>('/api/public/status/:slug/badge.svg', async (request, reply) => {
    limit(request, state.limits.badge);
    const p = badgeParams(request);
    const slug = request.params.slug;
    const key = `page\n${slug}\n${p.style}\n${p.label ?? '\u0000'}`;
    const svg = cachedBadge(key, () => (SLUG_RE.test(slug) ? pageFp(slug) : '-'), () => {
      const out = publicPage(slug);
      const label = p.label ?? 'status';
      if (!out) return na(p, 'status');
      if (out.paused) return renderBadge({ label, message: 'paused', color: 'grey', style: p.style });
      const map: Record<PublicStatus['overall'], [string, BadgeColor]> = {
        up: ['operational', 'green'],
        degraded: ['degraded', 'yellow'],
        down: ['down', 'red'],
        maintenance: ['maintenance', 'maintenance'],
        unknown: ['N/A', 'grey'],
      };
      const [message, color] = map[out.overall];
      return renderBadge({ label, message, color, style: p.style });
    });
    return sendBadge(reply, svg);
  });

  /* ------------------------------------------------------------- assets */

  app.get<{ Params: { sha256: string } }>('/api/public/assets/:sha256', async (request, reply) => {
    limit(request, state.limits.asset);
    const sha = request.params.sha256;
    // Only logos a published page uses: no confirmation oracle for arbitrary uploads and
    // nothing of unpublished pages (the dashboard uses the authenticated logo route).
    const asset = SHA256_RE.test(sha) && assetPublished(db, sha) ? getAsset(db, sha) : null;
    if (!asset) throw notFound();
    override(reply, {
      'Content-Security-Policy': ASSET_CSP,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // Content-addressed, but not immutable: it stops being served when no published page uses it.
      'Cache-Control': 'public, max-age=3600',
    });
    // Only the three sniffed raster types are ever stored (CHECK constraint).
    return reply.code(200).type(asset.mime).send(asset.bytes);
  });

  /* --------------------------------------------------------------- feed */

  app.get<{ Params: { slug: string } }>('/status/:slug/feed.xml', async (request, reply) => {
    limit(request, state.limits.feed);
    const slug = request.params.slug;
    const page = SLUG_RE.test(slug) ? pageBySlug(db, slug) : null;
    if (!page || page.published !== 1) return reply.code(404).type('text/plain; charset=utf-8').send('Not found\n');
    return reply
      .code(200)
      .type('application/rss+xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=60')
      .send(buildFeed(ctx, page));
  });

  /* ------------------------------------------------------ custom domains */

  /** Which status page does this Host serve? (SPA on a custom domain, at `/`.) */
  app.get('/api/public/status-host', async (request) => {
    limit(request, state.limits.status);
    return { slug: statusPageForHost(ctx, request.host) };
  });

  /** On-demand TLS `ask` endpoint: 200 only for verified domains of published pages. */
  app.get('/api/public/status-domain', async (request) => {
    limit(request, state.limits.misc);
    let domain: string;
    try {
      domain = normalizeStatusDomain(queryParam(request, 'domain') ?? '', null);
    } catch (err) {
      if (err instanceof HttpError) throw notFound();
      throw err;
    }
    if (statusPageForHost(ctx, domain) === null) throw notFound();
    return { ok: true };
  });

  /* ---------------------------------------------------------- uptime-bot */

  app.get('/uptime-bot', async (request, reply) => {
    limit(request, state.limits.misc);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>PTR Uptime bot</title></head>
<body>
<h1>PTR Uptime bot</h1>
<p>Requests with the User-Agent <code>PTR-Uptime/&lt;version&gt;</code> come from an uptime monitor run with
<a href="https://github.com/pieterdebaere/ptr_analytics">PTR Analytics</a>. A user of this server asked it to check
whether a website or service is reachable, typically once every one to five minutes.</p>
<h2>What the checks do</h2>
<ul>
<li>They only request what the user configured (for example one URL, a TCP port or a DNS record) and read at most a
small part of the answer.</li>
<li>They never follow links, never crawl and never submit forms.</li>
<li>Check frequency per destination is limited by the server.</li>
</ul>
<h2>Stopping the checks</h2>
<p>If you operate a destination that receives unwanted checks, contact the operator of the server that sends them
(the host name of this page). The operator can block destinations for all users.</p>
</body></html>
`;
    return reply.code(200).type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(html);
  });
}
