// Security notifications to the account owner (docs/SPEC.md §8.3): sent when two-factor
// authentication is enabled / disabled / reset, recovery codes are regenerated, an API key is
// created, API keys were revoked, or the second factor failed repeatedly. Only when a mailer
// is configured (hosted mode); never blocks or fails the request. The mails contain no
// secrets, no links with tokens and no user-chosen text except the API key name (single line,
// control characters already refused on input) — never anything an attacker could use.
import type { AppContext } from '../context.js';
import type { User } from '../data/users.js';
import { renderMail, type MailContent } from '../mail.js';

export type SecurityEvent =
  | { kind: 'mfa-enabled'; apiKeysRevoked: number }
  | { kind: 'mfa-disabled'; apiKeysRevoked: number }
  | { kind: 'recovery-codes' }
  | { kind: 'api-key-created'; name: string; scopes: readonly string[] }
  | { kind: 'mfa-failures' };

const APP = 'PTR Analytics';
const NOT_YOU =
  'If this was not you, change your password immediately, then check two-factor authentication and API keys in ' +
  'Settings → Security. Contact the operator of this server if you cannot sign in.';

function keysLine(n: number): string[] {
  return n > 0 ? [`${n} API key${n === 1 ? ' was' : 's were'} revoked; create new ones if you still need them.`] : [];
}

export function securityMail(event: SecurityEvent, loginUrl: string | null): MailContent {
  const where = loginUrl ? [`Sign in: ${loginUrl}`] : [];
  switch (event.kind) {
    case 'mfa-enabled':
      return renderMail('security-mfa-enabled', `Two-factor authentication was enabled on your ${APP} account`, [
        'Two-factor authentication was just enabled on your account. Signing in now needs a code from your authenticator app or a recovery code.',
        'All other sessions were signed out.',
        ...keysLine(event.apiKeysRevoked),
      ], undefined, [NOT_YOU, ...where]);
    case 'mfa-disabled':
      return renderMail('security-mfa-disabled', `Two-factor authentication was turned off on your ${APP} account`, [
        'Two-factor authentication was just removed from your account. Signing in now only needs your password.',
        'All other sessions were signed out.',
        ...keysLine(event.apiKeysRevoked),
      ], undefined, [NOT_YOU, ...where]);
    case 'recovery-codes':
      return renderMail('security-recovery-codes', `New recovery codes for your ${APP} account`, [
        'New two-factor recovery codes were just generated for your account. The previous codes no longer work.',
      ], undefined, [NOT_YOU, ...where]);
    case 'api-key-created':
      return renderMail('security-api-key', `A new API key was created for your ${APP} account`, [
        `An API key named "${event.name.slice(0, 100)}" with the scopes ${event.scopes.join(', ')} was just created for your account.`,
        'API keys give read access to your data without signing in. You can revoke keys in Settings → Security.',
      ], undefined, [NOT_YOU, ...where]);
    case 'mfa-failures':
      return renderMail('security-mfa-failures', `Repeated failed sign-in codes on your ${APP} account`, [
        'Several wrong two-factor codes were entered for your account. This usually means someone knows your password. ' +
          'Further attempts are slowed down and temporarily blocked.',
        'If this was not you, change your password now.',
      ], undefined, [NOT_YOU, ...where]);
  }
}

/** Mail the owner about a security-relevant change, when mail is configured. */
export function notifySecurity(ctx: AppContext, user: Pick<User, 'id' | 'email'>, event: SecurityEvent): void {
  const mailer = ctx.mailer;
  if (!mailer) return;
  try {
    const login = ctx.config.publicUrl ? `${ctx.config.publicUrl}/login` : null;
    mailer.send(user.email, securityMail(event, login));
  } catch (err) {
    ctx.log.warn({ err, userId: user.id }, 'could not queue a security notification');
  }
}
