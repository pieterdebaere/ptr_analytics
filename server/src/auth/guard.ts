import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AppContext } from '../context.js';
import type { User } from '../data/users.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';
import { apiKeyAllowedRoute, authenticateApiKey, bearerToken } from './api-keys.js';
import { sessionToken } from './cookie.js';
import { isMfaEnabled } from './mfa.js';

/**
 * Routes an admin without MFA can still use while REQUIRE_MFA_FOR_ADMINS is on: who am I,
 * and the enrolment endpoints.
 */
const MFA_POLICY_EXEMPT = new Set(['/api/auth/me', '/api/auth/mfa', '/api/auth/mfa/setup', '/api/auth/mfa/enable', '/api/auth/logout']);

/** REQUIRE_MFA_FOR_ADMINS is on and this user is an admin without MFA. */
export function mfaSetupRequired(ctx: AppContext, user: User | null): boolean {
  if (!ctx.config.uptime.requireMfaForAdmins || !user || user.role !== 'admin') return false;
  return !isMfaEnabled(ctx.db, user.id);
}

/** Admin must enrol MFA first (REQUIRE_MFA_FOR_ADMINS); enrolment endpoints stay usable. */
export function mfaPolicyBlocks(ctx: AppContext, request: FastifyRequest): boolean {
  const route = request.routeOptions.url;
  if (route !== undefined && MFA_POLICY_EXEMPT.has(route)) return false;
  return mfaSetupRequired(ctx, request.user);
}

/**
 * preHandler: require a valid login session, or — for read-only GET endpoints of the user's
 * data — an API key with the `read` scope (`Authorization: Bearer pa_…`). API keys never set
 * cookies and never reach mutations, auth, user, billing or key-management endpoints.
 */
export function requireAuth(ctx: AppContext): preHandlerAsyncHookHandler {
  return async function (request: FastifyRequest, _reply: FastifyReply) {
    const resolved = ctx.authSessions.resolve(sessionToken(request), ctx.now());
    if (resolved) {
      request.user = resolved.user;
      request.authTokenHash = resolved.tokenHash;
    } else {
      if (bearerToken(request) === null) throw unauthorized();
      if (!apiKeyAllowedRoute(request.method, request.routeOptions.url)) {
        throw new HttpError(403, 'api keys cannot be used for this request', 'api_key_forbidden');
      }
      const user = authenticateApiKey(ctx, request, 'read');
      if (!user) throw unauthorized();
      request.user = user;
      request.authTokenHash = null;
    }
    if (mfaPolicyBlocks(ctx, request)) throw new HttpError(403, 'mfa_required', 'mfa_required');
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
