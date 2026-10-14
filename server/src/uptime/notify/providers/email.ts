// E-mail. Hosted mode: always through the operator's SMTP (MAIL_FROM fixed, counts against
// MAIL_MAX_PER_HOUR), only to recipients that confirmed a double opt-in link, with a one-click
// unsubscribe link and List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058).
// Self-hosted admins may configure their own SMTP server URL (secret) and sender.
// Recipient bookkeeping (verification, unsubscribe tokens) lives in notify/email.ts; the
// dispatcher passes the confirmed recipients and a mail function in `ctx.email`.
import { renderMail } from '../../../mail.js';
import { isValidEmail } from '../../../config.js';
import { ValidationError, type FieldDef, type ProviderDefinition } from '../../types.js';
import { ext, type OutgoingNotifyMail } from '../context.js';
import { DeliveryError } from '../http.js';
import type { Message } from '../render.js';
import { checkEmails, list, optStr, validateFields, type Config, type Secrets } from './common.js';

export const MAX_EMAIL_RECIPIENTS = 5;

const FIELDS: readonly FieldDef[] = [
  {
    key: 'to',
    label: 'Recipients',
    kind: 'list',
    required: true,
    max: MAX_EMAIL_RECIPIENTS,
    maxLength: 254,
    help: 'Up to 5 addresses, one per line. On this server new recipients may have to confirm a link first.',
  },
  {
    key: 'smtpUrl',
    label: 'SMTP server URL',
    kind: 'password',
    secret: true,
    selfHostedOnly: true,
    group: 'Advanced',
    placeholder: 'smtps://user:password@smtp.example.com:465',
    help: "Optional. Leave empty to use the server's SMTP_URL. Stored encrypted.",
  },
  { key: 'from', label: 'Sender address', kind: 'text', selfHostedOnly: true, group: 'Advanced', maxLength: 254, placeholder: 'uptime@example.com' },
];

/** smtp(s)://[user:pass@]host[:port] */
export function checkSmtpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ValidationError('SMTP server URL must look like smtps://user:password@smtp.example.com:465', 'smtpUrl');
  }
  if ((u.protocol !== 'smtp:' && u.protocol !== 'smtps:') || !u.hostname || u.pathname.length > 1 || u.search) {
    throw new ValidationError('SMTP server URL must look like smtps://user:password@smtp.example.com:465', 'smtpUrl');
  }
  return u.toString();
}

/** Mail content for one recipient (exported for tests). */
export function notificationMail(m: Message, to: string, unsubscribeUrl: string | null, channelName: string): OutgoingNotifyMail {
  const subject = m.title.slice(0, 200);
  const paragraphs = [m.summary, ...m.facts.filter((f) => f.label !== 'Monitor').map((f) => `${f.label}: ${f.value}`)];
  const footer = [
    `You receive this e-mail because ${to} is a recipient of the notification channel "${channelName}".` +
      (unsubscribeUrl ? ` To stop receiving these e-mails, unsubscribe: ${unsubscribeUrl}` : ''),
  ];
  const content = renderMail('uptime-notification', subject, paragraphs, m.url ? { label: 'Open dashboard', url: m.url } : undefined, footer);
  const headers: Record<string, string> = { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' };
  if (unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return { to, subject, text: content.text, html: content.html, headers };
}

export const email: ProviderDefinition<Config, Secrets> = {
  id: 'email',
  label: 'E-mail',
  category: 'email',
  fields: FIELDS,
  hosted: 'allowed',
  validate(input, v) {
    const r = validateFields(FIELDS, input, v);
    const to = checkEmails(list(r.config, 'to'), 'to', 'Recipients');
    if (to.length === 0) throw new ValidationError('Recipients is required', 'to');
    r.config['to'] = [...new Set(to)];
    if (r.secrets['smtpUrl']) r.secrets['smtpUrl'] = checkSmtpUrl(r.secrets['smtpUrl']);
    const from = optStr(r.config, 'from');
    if (from !== undefined && !isValidEmail(from)) throw new ValidationError('Sender address must be a plain e-mail address', 'from');
    if (r.secrets['smtpUrl'] && from === undefined) throw new ValidationError('Sender address is required with a custom SMTP server', 'from');
    return r;
  },
  async send(base) {
    const ctx = ext(base);
    if (!ctx.email) throw new DeliveryError('e-mail is not configured on this server (SMTP_URL / MAIL_FROM)', { retryable: false });
    if (ctx.email.recipients.length === 0) throw new DeliveryError('no confirmed recipients', { retryable: false });
    const name = ctx.email.channelName;
    for (const r of ctx.email.recipients) {
      await ctx.email.send(notificationMail(ctx.message, r.address, r.unsubscribeUrl, name));
    }
    return {};
  },
};
