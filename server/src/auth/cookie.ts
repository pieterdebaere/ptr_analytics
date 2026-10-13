import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from './sessions.js';

/** Read the raw session token from the Cookie header (cookies are not parsed globally). */
export function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header.length === 0 || header.length > 8192) return undefined;
  return request.server.parseCookie(header)[SESSION_COOKIE];
}
