import type { FastifyRequest } from 'fastify';
import { sessionCookieName } from './sessions.js';

/**
 * Read the raw session token from the Cookie header (cookies are not parsed globally).
 * A header carrying the session cookie more than once is rejected: a duplicate can only come
 * from a cookie planted by another (sub)domain trying to shadow the real one.
 */
export function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return undefined;
  const name = sessionCookieName(request.server.ctx.config.cookieSecure);
  let seen = 0;
  for (const part of header.split(';')) {
    if (part.trim().startsWith(`${name}=`)) seen++;
  }
  if (seen !== 1) return undefined;
  return request.server.parseCookie(header)[name];
}
