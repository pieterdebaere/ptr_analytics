import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, PASSWORD_MIN, isValidEmail } from '../config.js';
import type { AppContext } from '../context.js';
import { requireMember } from '../auth/access.js';
import { requireAuth } from '../auth/guard.js';
import { field, objectBody } from '../lib/body.js';
import { clientIp, rateLimitKey } from '../lib/client-ip.js';
import { HttpError, badRequest, notFound, tooMany } from '../lib/errors.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/password.js';
import { accountDeletedMail, alreadyRegisteredMail, resetPasswordMail, verifyEmailMail, type Mailer } from '../mail.js';
import { clearSessionCookie, setSessionCookie, validPassword } from './auth.js';

const ACCEPTED = { ok: true } as const;

function parseEmail(v: unknown): string {
  const email = typeof v === 'string' && v.length <= 254 ? v.trim().toLowerCase() : '';
  if (!isValidEmail(email)) throw badRequest('invalid email');
  return email;
}

function parsePassword(v: unknown): string {
  if (!validPassword(v)) throw badRequest(`password must be ${PASSWORD_MIN}..${PASSWORD_MAX} characters`);
  return v;
}

const invalidLink = (): HttpError => badRequest('this link is invalid or has expired');

/**
 * Hosted-mode account endpoints (spec 6.3): public config, self-service sign-up with email
 * verification, password reset by email and account deletion.
 *
 * Sign-up and "forgot password" answer `202 {ok:true}` whatever the address, after the same
 * work (a password hash for sign-up), and mail is sent in the background: neither the
 * response nor its timing reveals whether an account exists.
 */
export async function accountRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const cloud = ctx.config.cloud;
  const publicUrl = ctx.config.publicUrl ?? '';
  const link = (page: 'verify' | 'reset', token: string): string => `${publicUrl}/${page}?token=${encodeURIComponent(token)}`;
  const ipKey = (request: FastifyRequest): string => rateLimitKey(clientIp(request));

  /** Sign-up related endpoints only exist when SIGNUP_ENABLED (which guarantees a mailer). */
  const signupMailer = (): Mailer => {
    if (!cloud.signupEnabled || !ctx.mailer) throw notFound();
    return ctx.mailer;
  };

  app.get('/api/public-config', async () => ({
    signupEnabled: cloud.signupEnabled,
    billingEnabled: cloud.billingEnabled,
    freeSites: cloud.freeSites,
    memberSiteLimit: cloud.memberSiteLimit,
    pricePerSiteCents: cloud.pricePerSiteCents,
    currency: cloud.priceCurrency,
    termsUrl: cloud.termsUrl,
    privacyUrl: cloud.privacyUrl,
  }));

  app.post('/api/auth/signup', async (request, reply) => {
    const mailer = signupMailer();
    const body = objectBody(request.body);
    const email = parseEmail(field(body, 'email'));
    const password = parsePassword(field(body, 'password'));
    if ((cloud.termsUrl !== null || cloud.privacyUrl !== null) && field(body, 'acceptTerms') !== true) {
      throw badRequest('you must accept the terms to sign up');
    }
    // Count before the expensive work; the per-email limit also bounds mail to one address.
    const ipOk = ctx.limits.signupIp.hit(ipKey(request));
    const emailOk = ctx.limits.signupEmail.hit(email);
    if (!ipOk || !emailOk) throw tooMany('too many sign-up attempts, try again later');

    // Hash in both cases so new and existing addresses take the same time.
    const hash = await hashPassword(password);
    const now = ctx.now();
    const outcome = ctx.db.transaction(() => {
      const existing = ctx.users.byEmail(email);
      if (existing) {
        // Never a verification link for an existing account (that could verify an account
        // pre-registered by someone else); a password reset proves control of the mailbox.
        return { existing: true, token: ctx.userTokens.issue(existing.id, 'reset', now) };
      }
      const user = ctx.users.create(email, hash, 'member', now, false);
      if (!user) throw new Error('could not create user');
      return { existing: false, token: ctx.userTokens.issue(user.id, 'verify', now) };
    })();
    mailer.send(
      email,
      outcome.existing ? alreadyRegisteredMail(link('reset', outcome.token), `${publicUrl}/login`) : verifyEmailMail(link('verify', outcome.token)),
    );
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/verify', async (request, reply) => {
    signupMailer();
    const body = objectBody(request.body);
    const token = field(body, 'token');
    if (!ctx.limits.tokenIp.hit(ipKey(request))) throw tooMany();
    const now = ctx.now();
    const user = ctx.db.transaction(() => {
      const userId = ctx.userTokens.consume(token, 'verify', now);
      if (userId === null) return null;
      ctx.users.markVerified(userId, now);
      return ctx.users.byId(userId);
    })();
    if (!user) throw invalidLink();
    const session = ctx.authSessions.create(user.id, now);
    setSessionCookie(ctx, reply, session.token);
    return { user };
  });

  app.post('/api/auth/forgot', async (request, reply) => {
    const mailer = signupMailer();
    const body = objectBody(request.body);
    const email = parseEmail(field(body, 'email'));
    const ipOk = ctx.limits.forgotIp.hit(ipKey(request));
    const emailOk = ctx.limits.forgotEmail.hit(email);
    if (!ipOk || !emailOk) throw tooMany('too many requests, try again later');
    const user = ctx.users.byEmail(email);
    if (user) mailer.send(email, resetPasswordMail(link('reset', ctx.userTokens.issue(user.id, 'reset', ctx.now()))));
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/reset', async (request, reply) => {
    signupMailer();
    const body = objectBody(request.body);
    const token = field(body, 'token');
    const password = parsePassword(field(body, 'password'));
    if (!ctx.limits.tokenIp.hit(ipKey(request))) throw tooMany();
    // Cheap validity check before the expensive hash; consumed atomically below.
    if (ctx.userTokens.peek(token, 'reset', ctx.now()) === null) throw invalidLink();
    const hash = await hashPassword(password);
    const now = ctx.now();
    const userId = ctx.db.transaction(() => {
      const id = ctx.userTokens.consume(token, 'reset', now);
      if (id === null) return null;
      ctx.users.setPasswordHash(id, hash);
      // The reset link proves control of the mailbox.
      ctx.users.markVerified(id, now);
      ctx.authSessions.deleteForUser(id);
      ctx.userTokens.deleteForUser(id);
      return id;
    })();
    if (userId === null) throw invalidLink();
    const user = ctx.users.byId(userId);
    if (user) ctx.limits.loginEmail.reset(user.email);
    return reply.code(204).send();
  });

  app.delete('/api/account', { preHandler: requireAuth(ctx) }, async (request, reply) => {
    const user = requireMember(request.user);
    const body = objectBody(request.body);
    const password = field(body, 'password');
    if (typeof password !== 'string' || password.length > PASSWORD_MAX) throw badRequest('password is required');
    const key = ipKey(request);
    const ipOk = ctx.limits.loginIp.hit(key);
    const pairOk = ctx.limits.loginEmailIp.hit(`${user.email}\n${key}`);
    if (!ipOk || !pairOk) throw tooMany('too many failed attempts, try again later');
    const hash = ctx.users.passwordHash(user.id);
    if (hash === null) {
      await dummyVerify(password);
      throw badRequest('password is incorrect');
    }
    if (!(await verifyPassword(password, hash))) throw badRequest('password is incorrect');
    ctx.limits.loginEmailIp.reset(`${user.email}\n${key}`);

    // Stop billing first: if Stripe cannot be reached, nothing is deleted (502).
    await ctx.billing.cancelAll(user.id);
    // Cascades: sessions, tokens, sites and all their analytics data.
    ctx.users.delete(user.id);
    ctx.mailer?.send(user.email, accountDeletedMail());
    request.log.info({ userId: user.id }, 'member account deleted');
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });
}
