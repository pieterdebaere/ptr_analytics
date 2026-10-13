import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/** Routes that are embedded on third-party sites. */
const CROSS_ORIGIN_PATHS = new Set(['/script.js', '/api/event']);

export function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Security headers for every response (spec 4.6). */
export function registerSecurityHeaders(app: FastifyInstance, config: Config): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    reply.header(
      'Cross-Origin-Resource-Policy',
      CROSS_ORIGIN_PATHS.has(pathOf(request.url)) ? 'cross-origin' : 'same-origin',
    );
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
}

/**
 * CSRF (spec 4.6): every non-GET/HEAD request to /api/* except /api/event must carry
 * `X-PA-Request: 1`; a present Origin must equal PUBLIC_URL's origin (or the request Host).
 */
export function registerCsrfCheck(app: FastifyInstance, config: Config): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const path = pathOf(request.url);
    if (!isApiPath(path) || path === '/api/event') return;
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
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host === request.host;
  } catch {
    return false;
  }
}
