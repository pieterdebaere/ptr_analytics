import { createTransport } from 'nodemailer';
import { RateLimiter } from './lib/rate-limit.js';

/** A fully rendered email. */
export interface MailContent {
  /** Template name: a queued mail to the same recipient with the same template is replaced. */
  template: string;
  subject: string;
  text: string;
  html: string;
}

export interface OutgoingMail extends MailContent {
  from: string;
  to: string;
}

/** Delivers one email. Injectable so tests can capture outgoing mail. */
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
  close?(): void;
}

/**
 * nodemailer SMTP transport from SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465).
 * `smtp://` connections must upgrade with STARTTLS (`requireTLS`) unless `allowInsecure`
 * (SMTP_ALLOW_INSECURE=true, e.g. a relay on localhost): links in our mail are credentials.
 */
export function smtpTransport(
  url: string,
  opts: { allowInsecure?: boolean } = {},
  create: (options: Parameters<typeof createTransport>[0]) => Pick<ReturnType<typeof createTransport>, 'sendMail' | 'close'> = createTransport,
): MailTransport {
  const cleartext = url.toLowerCase().startsWith('smtp:');
  const transporter = create({
    url,
    ...(cleartext && !opts.allowInsecure ? { requireTLS: true } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  });
  return {
    async send(mail) {
      await transporter.sendMail({
        from: mail.from,
        // An address object: never re-parsed as a header (no display-name / list tricks).
        to: { name: '', address: mail.to },
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // Our content never references files or URLs to embed.
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    },
    close() {
      transporter.close();
    },
  };
}

interface MailLog {
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const MAX_MAIL_QUEUE = 500;
const CONCURRENCY = 2;
const HOUR_MS = 3_600_000;

export interface MailerOptions {
  /** Max mails accepted per hour over all recipients (MAIL_MAX_PER_HOUR). */
  maxPerHour?: number;
  /** Max queued (not yet sending) mails. */
  maxQueue?: number;
  now?: () => number;
}

/** Outcome of `Mailer.send()`. */
export type SendResult = 'queued' | 'replaced' | 'rejected';

/**
 * Sends mail in the background: `send()` only enqueues, so HTTP responses never wait for
 * (or reveal anything through the timing of) SMTP delivery. The queue is bounded and the
 * number of mails per hour is capped; callers check `hasCapacity()` first and answer 503
 * when there is none, instead of silently dropping mail. A queued mail to the same recipient
 * with the same template is replaced by the newer one (no duplicate mails). Failures are
 * logged without addresses, links or SMTP credentials.
 */
export class Mailer {
  private readonly queue: OutgoingMail[] = [];
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly hourly: RateLimiter;
  private readonly maxQueue: number;

  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly log: MailLog,
    opts: MailerOptions = {},
  ) {
    this.maxQueue = opts.maxQueue ?? MAX_MAIL_QUEUE;
    this.hourly = new RateLimiter(opts.maxPerHour ?? 500, HOUR_MS, opts.now ?? Date.now, 1);
  }

  /** True when a mail sent now would be accepted (queue not full, hourly cap not reached). */
  hasCapacity(): boolean {
    return !this.closed && this.queue.length < this.maxQueue && !this.hourly.isLimited('all');
  }

  send(to: string, content: MailContent): SendResult {
    if (this.closed) return 'rejected';
    const mailbox = to.toLowerCase();
    const queued = this.queue.findIndex((m) => m.to.toLowerCase() === mailbox && m.template === content.template);
    if (queued !== -1) {
      // Same recipient + template still waiting: send only the newest one.
      this.queue[queued] = { ...content, from: this.from, to };
      return 'replaced';
    }
    if (this.queue.length >= this.maxQueue) {
      this.log.warn({}, 'mail queue full, not sending an email');
      return 'rejected';
    }
    if (!this.hourly.hit('all')) {
      this.log.warn({}, 'hourly mail limit (MAIL_MAX_PER_HOUR) reached, not sending an email');
      return 'rejected';
    }
    this.queue.push({ ...content, from: this.from, to });
    this.pump();
    return 'queued';
  }

  /** Resolves once every queued mail has been attempted (tests, shutdown). */
  idle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop accepting mail and wait (at most `waitMs`) for queued mail to go out. */
  async close(waitMs = 5_000): Promise<void> {
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.idle(), new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
    this.transport.close?.();
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const mail = this.queue.shift() as OutgoingMail;
      this.active++;
      this.transport
        .send(mail)
        .catch((err: unknown) => {
          const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
          this.log.error(
            {
              code: typeof e?.code === 'string' ? e.code : undefined,
              responseCode: typeof e?.responseCode === 'number' ? e.responseCode : undefined,
              command: typeof e?.command === 'string' ? e.command : undefined,
            },
            'failed to send email',
          );
        })
        .finally(() => {
          this.active--;
          this.pump();
          if (this.active === 0 && this.queue.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
          }
        });
    }
  }
}

// ---- templates ----

/**
 * Link to a dashboard page carrying a token. The token is in the URL *fragment*, which
 * browsers never send to the server: it stays out of access logs, proxies and Referer headers.
 */
export function tokenLink(publicUrl: string, page: 'verify' | 'reset', token: string): string {
  return `${publicUrl}/${page}#token=${encodeURIComponent(token)}`;
}

const APP = 'PTR Analytics';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface Action {
  label: string;
  url: string;
}

function layout(title: string, paragraphs: string[], action: Action | undefined, footer: string[]): string {
  const p = (text: string, style = 'margin:0 0 16px') => `<p style="${style}">${escapeHtml(text)}</p>`;
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#111827;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">Or copy this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
    : '';
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    `<title>${escapeHtml(title)}</title></head>` +
    '<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;line-height:1.5">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">' +
    `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>` +
    paragraphs.map((t) => p(t)).join('') +
    button +
    footer.map((t) => p(t, 'margin:16px 0 0;font-size:13px;color:#6b7280')).join('') +
    p(APP, 'margin:24px 0 0;font-size:12px;color:#9ca3af') +
    '</div></body></html>'
  );
}

function render(template: string, subject: string, paragraphs: string[], action?: Action, footer: string[] = []): MailContent {
  const text = [...paragraphs, ...(action ? [`${action.label}:\n${action.url}`] : []), ...footer, `-- ${APP}`].join('\n\n');
  return { template, subject, text: `${text}\n`, html: layout(subject, paragraphs, action, footer) };
}

export function verifyEmailMail(link: string): MailContent {
  return render(
    'verify',
    `Confirm your email address for ${APP}`,
    [
      'Thanks for signing up! Please confirm your email address to activate your account. The link is valid for 24 hours; ' +
        'you will be asked for the password you chose when signing up.',
    ],
    { label: 'Confirm email address', url: link },
    [
      'If you did not sign up, you can ignore this email; the account will not be activated. ' +
        'If you did not choose the password, use "Forgot password" instead.',
    ],
  );
}

export function alreadyRegisteredMail(resetLink: string, loginLink: string): MailContent {
  return render(
    'already-registered',
    `You already have a ${APP} account`,
    [
      'Someone (hopefully you) tried to sign up with this email address, but an account already exists.',
      `You can log in at ${loginLink}. If you forgot your password, set a new one with the link below (valid for 1 hour).`,
    ],
    { label: 'Reset password', url: resetLink },
    ['If this was not you, you can ignore this email. Your account has not been changed.'],
  );
}

/** "Already registered" for operator accounts (admin/viewer): no reset link (CLI only). */
export function alreadyRegisteredOperatorMail(loginLink: string): MailContent {
  return render('already-registered', `You already have a ${APP} account`, [
    'Someone (hopefully you) tried to sign up with this email address, but an account already exists.',
    `You can log in at ${loginLink}. If you forgot your password, ask the operator of this server to reset it.`,
  ], undefined, ['If this was not you, you can ignore this email. Your account has not been changed.']);
}

export function resetPasswordMail(link: string): MailContent {
  return render(
    'reset',
    `Reset your ${APP} password`,
    ['We received a request to reset your password. The link is valid for 1 hour and can be used once.'],
    { label: 'Choose a new password', url: link },
    ['If you did not request this, you can ignore this email. Your password has not been changed.'],
  );
}

export function accountDeletedMail(): MailContent {
  return render('account-deleted', `Your ${APP} account has been deleted`, [
    'Your account, all your sites and their analytics data have been deleted. Any subscription has been cancelled.',
    'Thanks for using ' + APP + '.',
  ]);
}
