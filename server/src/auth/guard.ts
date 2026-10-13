import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';
import { sessionToken } from './cookie.js';

/** preHandler: require a valid login session. */
export function requireAuth(ctx: AppContext): preHandlerAsyncHookHandler {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    const resolved = ctx.authSessions.resolve(sessionToken(request), ctx.now());
    if (!resolved) throw unauthorized();
    request.user = resolved.user;
    request.authTokenHash = resolved.tokenHash;
  };
}

/** preHandler: require an admin (use after requireAuth). */
export function requireAdmin(): preHandlerAsyncHookHandler {
  return async function (request: FastifyRequest) {
    if (!request.user) throw unauthorized();
    if (request.user.role !== 'admin') throw forbidden('admin role required');
  };
}

export function currentUser(request: FastifyRequest) {
  if (!request.user) throw new HttpError(401, 'unauthorized');
  return request.user;
}
