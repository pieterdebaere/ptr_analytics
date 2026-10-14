import type { AppContext } from '../context.js';
import type { User } from '../data/users.js';
import { tokenLink, verifyEmailMail } from '../mail.js';

/**
 * Login of an unverified member with the right password (spec 6.3): the client gets the
 * same 401 as for a wrong password, and the verification mail is sent again in the
 * background, at most once per 10 minutes and 3 times per day per account.
 */
export function resendVerification(ctx: AppContext, user: User): void {
  const mailer = ctx.mailer;
  if (!ctx.config.cloud.signupEnabled || !mailer || ctx.config.publicUrl === null) return;
  const key = String(user.id);
  if (ctx.limits.verifyResend.isLimited(key) || ctx.limits.verifyResendDaily.isLimited(key) || !mailer.hasCapacity()) return;
  ctx.limits.verifyResend.hit(key);
  ctx.limits.verifyResendDaily.hit(key);
  const token = ctx.userTokens.issue(user.id, 'verify', ctx.now());
  mailer.send(user.email, verifyEmailMail(tokenLink(ctx.config.publicUrl, 'verify', token)));
}
