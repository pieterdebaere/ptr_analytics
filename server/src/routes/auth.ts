import type { FastifyInstance, FastifyReply } from 'fastify';
import { PASSWORD_MAX, PASSWORD_MIN, mailboxKey } from '../config.js';
import type { AppContext } from '../context.js';
import { sessionToken } from '../auth/cookie.js';
import { currentUser, mfaSetupRequired, requireAuth } from '../auth/guard.js';
import { apiKeyState } from '../auth/api-keys.js';
import {
  answerMfaChallenge,
  challengeUser,
  dropChallenges,
  isMfaEnabled,
  issueMfaChallenge,
  mfaGate,
  mfaLimits,
  mfaStatus,
  recordMfaFailure,
  recordMfaSuccess,
} from '../auth/mfa.js';
import { notifySecurity } from '../auth/notices.js';
import { resendVerification } from '../auth/verification.js';
import { SESSION_TTL_MS, sessionCookieName } from '../auth/sessions.js';
import { field, objectBody } from '../lib/body.js';
import { clientIp, rateLimitKey } from '../lib/client-ip.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/password.js';

export function validPassword(v: unknown): v is string {
  return typeof v === 'string' && v.length >= PASSWORD_MIN && v.length <= PASSWORD_MAX;
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(sessionCookieName(ctx.config.cookieSecure), token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: ctx.config.cookieSecure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(ctx.config.cookieSecure), {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: ctx.config.cookieSecure,
  });
}

export async function authRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const auth = requireAuth(ctx);

  app.post('/api/auth/login', async (request, reply) => {
    const body = objectBody(request.body);
    const emailRaw = field(body, 'email');
    const password = field(body, 'password');
    if (typeof emailRaw !== 'string' || emailRaw.length > 254 || typeof password !== 'string' || password.length > PASSWORD_MAX) {
      throw badRequest('email and password are required');
    }
    const email = mailboxKey(emailRaw);
    // Count the attempt *before* the (async) password check: checking first and counting
    // afterwards lets a burst of concurrent requests slip past the limit.
    const ipKey = rateLimitKey(clientIp(request));
    const ipOk = ctx.limits.loginIp.hit(ipKey);
    const pairOk = ctx.limits.loginEmailIp.hit(`${email}\n${ipKey}`);
    const emailOk = ctx.limits.loginEmail.hit(email);
    if (!ipOk || !pairOk || !emailOk) {
      throw new HttpError(429, 'too many login attempts, try again later');
    }

    const found = ctx.users.byEmailWithHash(email);
    let ok = false;
    if (found) ok = await verifyPassword(password, found.passwordHash);
    else await dummyVerify(password);

    if (!found || !ok) {
      throw new HttpError(401, 'invalid email or password');
    }
    if (found.user.role === 'member' && !found.user.emailVerified) {
      // Exactly the answer of a wrong password: otherwise sign-up + login with a guessed
      // password would tell whether an address has an account. The owner gets the
      // verification mail again instead (rate limited per account).
      resendVerification(ctx, found.user);
      throw new HttpError(401, 'invalid email or password');
    }
    // Two-factor accounts: no session yet, only a short-lived single-use challenge token
    // (spec §8.3). The login counters are reset once the second factor succeeded.
    if (isMfaEnabled(ctx.db, found.user.id)) {
      return { mfaRequired: true, mfaToken: issueMfaChallenge(ctx, found.user.id, found.passwordHash) };
    }
    ctx.limits.loginEmailIp.reset(`${email}\n${ipKey}`);
    const { token } = ctx.authSessions.create(found.user.id, ctx.now());
    setSessionCookie(ctx, reply, token);
    return { user: found.user };
  });

  /**
   * Second login step: `{mfaToken, code | recoveryCode}` → session. Limited per client IP,
   * per token (5 attempts) and per account (progressive lockout + daily cap, auth/mfa.ts; a
   * successful login does not reset the daily budget); the token is single use and dies with
   * a password change. Everything after the body checks is synchronous (no interleaving
   * requests).
   */
  app.post('/api/auth/login/mfa', async (request, reply) => {
    const body = objectBody(request.body);
    const mfaToken = field(body, 'mfaToken');
    const code = field(body, 'code');
    const recoveryCode = field(body, 'recoveryCode');
    if (typeof mfaToken !== 'string' || (typeof code !== 'string' && typeof recoveryCode !== 'string')) {
      throw badRequest('mfaToken and code (or recoveryCode) are required');
    }
    const limits = mfaLimits(ctx);
    const ipKey = rateLimitKey(clientIp(request));
    if (!limits.ip.hit(ipKey)) throw new HttpError(429, 'too many attempts, try again later');
    const owner = challengeUser(ctx, mfaToken);
    if (owner !== null) {
      const gate = mfaGate(ctx, owner);
      if (!gate.ok) throw new HttpError(429, `too many wrong codes, try again in ${Math.ceil(gate.retryAfterMs / 60_000)} min`, 'mfa_locked');
    }
    const res = answerMfaChallenge(ctx, mfaToken, { code, recoveryCode }, (id) => ctx.users.passwordHash(id));
    if (!res.ok) {
      if (res.reason === 'invalid_token') throw new HttpError(401, 'this sign-in has expired, please sign in again', 'mfa_expired');
      if (owner !== null && recordMfaFailure(ctx, owner).alert) {
        const victim = ctx.users.byId(owner);
        if (victim) notifySecurity(ctx, victim, { kind: 'mfa-failures' });
      }
      throw new HttpError(401, 'invalid code', 'invalid_code');
    }
    const user = ctx.users.byId(res.userId);
    if (!user || (user.role === 'member' && !user.emailVerified)) throw new HttpError(401, 'this sign-in has expired, please sign in again', 'mfa_expired');
    recordMfaSuccess(ctx, user.id);
    ctx.limits.loginEmailIp.reset(`${mailboxKey(user.email)}\n${ipKey}`);
    const { token } = ctx.authSessions.create(user.id, ctx.now());
    setSessionCookie(ctx, reply, token);
    return res.usedRecoveryCode
      ? { user, recoveryCodesLeft: mfaStatus(ctx.db, user.id).recoveryCodesLeft }
      : { user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = sessionToken(request);
    if (token !== undefined) ctx.authSessions.deleteToken(token);
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: auth }, async (request) => {
    const user = currentUser(request);
    // mfaSetupRequired: REQUIRE_MFA_FOR_ADMINS and this admin has not enrolled yet (every
    // other endpoint answers 403 {code: "mfa_required"} until it has).
    return { user, mfaEnabled: isMfaEnabled(ctx.db, user.id), mfaSetupRequired: mfaSetupRequired(ctx, user) };
  });

  app.post('/api/auth/password', { preHandler: auth }, async (request, reply) => {
    const user = currentUser(request);
    const body = objectBody(request.body);
    const currentPassword = field(body, 'currentPassword');
    const newPassword = field(body, 'newPassword');
    if (typeof currentPassword !== 'string' || currentPassword.length > PASSWORD_MAX) throw badRequest('invalid currentPassword');
    if (!validPassword(newPassword)) {
      throw badRequest(`new password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
    }
    const ipKey = rateLimitKey(clientIp(request));
    const ipOk = ctx.limits.loginIp.hit(ipKey);
    const pairOk = ctx.limits.loginEmailIp.hit(`${mailboxKey(user.email)}\n${ipKey}`);
    if (!ipOk || !pairOk) {
      throw new HttpError(429, 'too many failed attempts, try again later');
    }
    const hash = ctx.users.passwordHash(user.id);
    if (hash === null || !(await verifyPassword(currentPassword, hash))) {
      throw badRequest('current password is incorrect');
    }
    ctx.limits.loginEmailIp.reset(`${mailboxKey(user.email)}\n${ipKey}`);
    ctx.users.setPasswordHash(user.id, await hashPassword(newPassword));
    ctx.authSessions.deleteForUser(user.id, request.authTokenHash ?? undefined);
    // API keys minted with a stolen session must not survive the owner's password change.
    apiKeyState(ctx).repo.deleteForUser(user.id);
    dropChallenges(ctx, user.id);
    return reply.code(204).send();
  });
}
