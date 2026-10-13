import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/** Routes that are embedded on third-party sites. */
const CROSS_ORIGIN_PATHS = new Set(['/script.js', '/api/event']);

/** Dashboard pages opened from mailed links carrying a token: never leak anything via Referer. */
const NO_REFERRER_PATHS = new Set(['/verify', '/reset']);

export function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Set the security headers (spec 4.6) on a reply. */
export function applySecurityHeaders(request: FastifyRequest, reply: FastifyReply, config: Config): void {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', NO_REFERRER_PATHS.has(pathOf(request.url)) ? 'no-referrer' : 'strict-origin-when-cross-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Permissions-Policy', PERMISSIONS_POLICY);
  reply.header(
    'Cross-Origin-Resource-Policy',
    CROSS_ORIGIN_PATHS.has(pathOf(request.url)) ? 'cross-origin' : 'same-origin',
  );
  if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Authenticated API data must never be stored by browsers or shared caches.
  if (isApiPath(pathOf(request.url)) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
}

/** Security headers for every response. */
export function registerSecurityHeaders(app: FastifyInstance, config: Config): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    applySecurityHeaders(request, reply, config);
    return payload;
  });
}

/**
 * CSRF (spec 4.6): every non-GET/HEAD/OPTIONS request except the public ingest route and the
 * Stripe webhook (server-to-server, authenticated by its signature, never by cookies) must
 * carry `X-PA-Request: 1`; a present Origin must equal PUBLIC_URL's origin (or the request Host).
 *
 * The exemption is decided on the *matched route* (`routeOptions.url`), not on the raw URL:
 * the router decodes and normalises paths (`/%61pi/users` routes to `/api/users`), so a check
 * on the raw string could be bypassed. Everything else is checked (default deny).
 */
const CSRF_EXEMPT_ROUTES = new Set(['/api/event', '/api/billing/webhook']);

export function registerCsrfCheck(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const route = request.routeOptions.url;
    if (route !== undefined && CSRF_EXEMPT_ROUTES.has(route)) return;
    if (request.headers['x-pa-request'] !== '1' || !originAllowed(request, config)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });
}

function originAllowed(request: FastifyRequest, config: Config): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (config.publicUrl !== null) return origin === config.publicUrl;
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}` === `${request.protocol}://${request.host}`;
  } catch {
    return false;
  }
}
