// Custom domains of status pages: DNS TXT verification and Host → page mapping.
//
// Verification: the owner publishes TXT `_ptr-status.<domain>` = the page's verify token; we
// query it with our own `dns.promises.Resolver` (timeouts, never dns.lookup).
// Serving: `statusPageForHost(ctx, host)` returns the slug of the published page owning a
// verified domain. The SPA asks `GET /api/public/status-host` on load (same idea as Uptime
// Kuma's entry page), and routes/static.ts may redirect `/` with it, e.g.
//   const slug = statusPageForHost(ctx, request.host); if (slug) return reply.redirect(`/status/${slug}`);
// TLS for custom domains is the reverse proxy's job; `GET /api/public/status-domain?domain=`
// answers 200 only for verified domains (Caddy on-demand TLS `ask` endpoint).
import { Resolver } from 'node:dns/promises';
import type { AppContext } from '../../context.js';

const VERIFY_TIMEOUT_MS = 5000;

/** Replaceable for tests. Returns the TXT records (chunks joined) of `name`. */
export const txtLookup = {
  resolve: async (name: string): Promise<string[]> => {
    const resolver = new Resolver({ timeout: 2000, tries: 2 });
    const timer = setTimeout(() => resolver.cancel(), VERIFY_TIMEOUT_MS);
    try {
      const records = await resolver.resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Does `_ptr-status.<domain>` carry the token? DNS errors count as "not verified". */
export async function verifyDomainTxt(domain: string, token: string): Promise<boolean> {
  try {
    const records = await txtLookup.resolve(`_ptr-status.${domain}`);
    return records.some((r) => r.trim() === token);
  } catch {
    return false;
  }
}

/** Normalise a Host header value: lowercase, without port and trailing dot. */
export function normalizeHost(host: string | undefined): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > 260) return null;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return null; // IPv6 literal: never a custom domain
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  h = h.replace(/\.$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(h) ? h : null;
}

/**
 * Slug of the published status page served on this host (a verified custom domain), or null.
 * Intended for routes/static.ts (serve the status page at `/` on a custom domain).
 */
export function statusPageForHost(ctx: AppContext, host: string | undefined): string | null {
  const h = normalizeHost(host);
  if (h === null) return null;
  const r = ctx.db
    .prepare(
      `SELECT p.slug FROM status_page_domains d
       JOIN status_pages p ON p.id = d.status_page_id AND p.deleted_at IS NULL AND p.published = 1
       JOIN sites s ON s.id = p.site_id AND s.deleted_at IS NULL
       WHERE d.domain = ? AND d.verified_at IS NOT NULL`,
    )
    .get(h) as { slug: string } | undefined;
  return r?.slug ?? null;
}
