import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PASSWORD_MAX, PASSWORD_MIN, isValidEmail, mailboxKey } from '../config.js';
import type { AppContext } from '../context.js';
import { requireMember } from '../auth/access.js';
import { apiKeyState } from '../auth/api-keys.js';
import { requireAuth } from '../auth/guard.js';
import { isMfaEnabled, issueMfaChallenge } from '../auth/mfa.js';
import { schedulePurge } from '../jobs/purge.js';
import { field, objectBody } from '../lib/body.js';
import { clientIp, rateLimitKey, rateLimitKey48 } from '../lib/client-ip.js';
import { HttpError, badRequest, notFound, tooMany, tryLater } from '../lib/errors.js';
import { dummyVerify, hashPassword, verifyPassword } from '../lib/password.js';
import {
  accountDeletedMail,
  alreadyRegisteredMail,
  alreadyRegisteredOperatorMail,
  resetPasswordMail,
  tokenLink,
  verifyEmailMail,
  type Mailer,
} from '../mail.js';
import { clearSessionCookie, setSessionCookie, validPassword } from './auth.js';

const ACCEPTED = { ok: true } as const;

function parseEmail(v: unknown): string {
  const email = typeof v === 'string' && v.length <= 254 ? mailboxKey(v) : '';
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
 * response nor its timing reveals whether an account exists. When mail cannot be accepted
 * (queue full, hourly caps) both answer 503 before looking at the address.
 *
 * Verification needs the account's password as well as the mailed token: a link alone
 * proves control of the mailbox, not that the clicker chose the account's password, so it
 * must neither log in a victim to an attacker's account (login CSRF) nor activate an
 * account pre-registered by someone else with a password they know.
 */
export async function accountRoutes(app: FastifyInstance, opts: { ctx: AppContext }): Promise<void> {
  const { ctx } = opts;
  const cloud = ctx.config.cloud;
  const publicUrl = ctx.config.publicUrl ?? '';
  const link = (page: 'verify' | 'reset', token: string): string => tokenLink(publicUrl, page, token);
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
    // Origin public status pages are served on (STATUS_PAGE_ORIGIN), null = this origin.
    statusPageOrigin: ctx.config.statusPageOrigin,
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
    const ip = clientIp(request);
    const ipOk = ctx.limits.signupIp.hit(rateLimitKey(ip));
    const net48 = rateLimitKey48(ip);
    const netOk = net48 === null || ctx.limits.signupIp48.hit(net48);
    const emailOk = ctx.limits.signupEmail.hit(email);
    if (!ipOk || !netOk || !emailOk) throw tooMany('too many sign-up attempts, try again later');
    // Global caps, checked before the address is looked at (same answer for every address).
    if (!ctx.limits.signupGlobal.hit('all') || !mailer.hasCapacity()) throw tryLater();
    if (ctx.users.countUnverified() >= cloud.maxUnverifiedAccounts) {
      request.log.warn('MAX_UNVERIFIED_ACCOUNTS reached; sign-up is paused until unverified accounts expire');
      throw tryLater();
    }

    // Hash in both cases so new and existing addresses take the same time.
    const hash = await hashPassword(password);
    const now = ctx.now();
    const outcome = ctx.db.transaction(() => {
      const existing = ctx.users.byEmail(email);
      if (existing) {
        // Never a verification link for an existing account (that could verify an account
        // pre-registered by someone else); a password reset proves control of the mailbox.
        // Operator accounts are never reset by mail (CLI only).
        if (existing.role !== 'member') return { createdId: null, mail: alreadyRegisteredOperatorMail(`${publicUrl}/login`) };
        const token = ctx.userTokens.issue(existing.id, 'reset', now);
        return { createdId: null, mail: alreadyRegisteredMail(link('reset', token), `${publicUrl}/login`) };
      }
      const user = ctx.users.create(email, hash, 'member', now, false);
      if (!user) throw new Error('could not create user');
      return { createdId: user.id, mail: verifyEmailMail(link('verify', ctx.userTokens.issue(user.id, 'verify', now))) };
    })();
    if (mailer.send(email, outcome.mail) === 'rejected') {
      // Nobody could ever verify it: do not keep the account (it has no sites or billing).
      if (outcome.createdId !== null) ctx.users.delete(outcome.createdId, now);
      throw tryLater();
    }
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/verify', async (request, reply) => {
    signupMailer();
    const body = objectBody(request.body);
    const token = field(body, 'token');
    const password = field(body, 'password');
    if (typeof password !== 'string' || password.length > PASSWORD_MAX) throw badRequest('password is required');
    const key = ipKey(request);
    // Every submission counts, including a wrong password for a valid token.
    if (!ctx.limits.tokenIp.hit(key)) throw tooMany();
    const userId = ctx.userTokens.peek(token, 'verify', ctx.now());
    const user = userId === null ? null : ctx.users.byId(userId);
    const hash = user ? ctx.users.passwordHash(user.id) : null;
    if (!user || hash === null || user.role !== 'member') throw invalidLink();
    // The password check goes through the login rate limits (it is a login).
    const mailbox = mailboxKey(user.email);
    const ipOk = ctx.limits.loginIp.hit(key);
    const pairOk = ctx.limits.loginEmailIp.hit(`${mailbox}\n${key}`);
    const emailOk = ctx.limits.loginEmail.hit(mailbox);
    if (!ipOk || !pairOk || !emailOk) throw tooMany('too many attempts, try again later');
    // Wrong password: the same answer as a bad link, and the token stays valid for the owner.
    if (!(await verifyPassword(password, hash))) throw invalidLink();
    const now = ctx.now();
    const verified = ctx.db.transaction(() => {
      if (ctx.userTokens.consume(token, 'verify', now) !== user.id) throw invalidLink();
      // The password must not have changed while it was being checked.
      if (ctx.users.passwordHash(user.id) !== hash) throw invalidLink();
      ctx.users.markVerified(user.id, now);
      ctx.userTokens.deleteForUser(user.id, 'verify');
      return ctx.users.byId(user.id);
    })();
    if (!verified) throw invalidLink();
    // Every session-creating path goes through the MFA gate (spec §8.3).
    if (isMfaEnabled(ctx.db, verified.id)) return { mfaRequired: true, mfaToken: issueMfaChallenge(ctx, verified.id, hash) };
    ctx.limits.loginEmailIp.reset(`${mailbox}\n${key}`);
    const session = ctx.authSessions.create(verified.id, now);
    setSessionCookie(ctx, reply, session.token);
    return { user: verified };
  });

  app.post('/api/auth/forgot', async (request, reply) => {
    const mailer = signupMailer();
    const body = objectBody(request.body);
    const email = parseEmail(field(body, 'email'));
    const ipOk = ctx.limits.forgotIp.hit(ipKey(request));
    const emailOk = ctx.limits.forgotEmail.hit(email);
    if (!ipOk || !emailOk) throw tooMany('too many requests, try again later');
    // Checked before the address is looked at, so the answer does not depend on it.
    if (!mailer.hasCapacity()) throw tryLater();
    const user = ctx.users.byEmail(email);
    // Operator accounts (admin, viewer) are only reset with the CLI: same answer, no mail.
    if (user && user.role === 'member') {
      mailer.send(email, resetPasswordMail(link('reset', ctx.userTokens.issue(user.id, 'reset', ctx.now()))));
    }
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/api/auth/reset', async (request, reply) => {
    signupMailer();
    const body = objectBody(request.body);
    const token = field(body, 'token');
    const password = parsePassword(field(body, 'password'));
    if (!ctx.limits.tokenIp.hit(ipKey(request))) throw tooMany();
    // Cheap validity check before the expensive hash; consumed atomically below.
    const peeked = ctx.userTokens.peek(token, 'reset', ctx.now());
    if (peeked === null || ctx.users.byId(peeked)?.role !== 'member') throw invalidLink();
    const hash = await hashPassword(password);
    const now = ctx.now();
    const userId = ctx.db.transaction(() => {
      const id = ctx.userTokens.consume(token, 'reset', now);
      if (id === null) return null;
      if (ctx.users.byId(id)?.role !== 'member') throw invalidLink();
      ctx.users.setPasswordHash(id, hash);
      // The reset link proves control of the mailbox.
      ctx.users.markVerified(id, now);
      ctx.authSessions.deleteForUser(id);
      // A reset is the recovery path after a compromise: API keys go too.
      apiKeyState(ctx).repo.deleteForUser(id);
      // Every outstanding verify / reset link of the account stops working.
      ctx.userTokens.deleteForUser(id);
      return id;
    })();
    if (userId === null) throw invalidLink();
    const user = ctx.users.byId(userId);
    if (user) ctx.limits.loginEmail.reset(mailboxKey(user.email));
    return reply.code(204).send();
  });

  app.delete('/api/account', { preHandler: requireAuth(ctx) }, async (request, reply) => {
    const user = requireMember(request.user);
    const body = objectBody(request.body);
    const password = field(body, 'password');
    if (typeof password !== 'string' || password.length > PASSWORD_MAX) throw badRequest('password is required');
    const key = ipKey(request);
    const ipOk = ctx.limits.loginIp.hit(key);
    const pairOk = ctx.limits.loginEmailIp.hit(`${mailboxKey(user.email)}\n${key}`);
    if (!ipOk || !pairOk) throw tooMany('too many failed attempts, try again later');
    const hash = ctx.users.passwordHash(user.id);
    if (hash === null) {
      await dummyVerify(password);
      throw badRequest('password is incorrect');
    }
    if (!(await verifyPassword(password, hash))) throw badRequest('password is incorrect');
    ctx.limits.loginEmailIp.reset(`${mailboxKey(user.email)}\n${key}`);

    // Stop billing first: if Stripe cannot be reached, nothing is deleted (502).
    await ctx.billing.cancelAll(user.id);
    // Sessions and tokens cascade; the sites are soft-deleted at once and their analytics
    // data is purged in the background (never one huge synchronous cascade).
    ctx.users.delete(user.id, ctx.now());
    schedulePurge(ctx);
    ctx.mailer?.send(user.email, accountDeletedMail());
    request.log.info({ userId: user.id }, 'member account deleted');
    clearSessionCookie(ctx, reply);
    return reply.code(204).send();
  });
}
