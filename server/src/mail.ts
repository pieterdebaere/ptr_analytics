import { createTransport } from 'nodemailer';

/** A fully rendered email. */
export interface MailContent {
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

/** nodemailer SMTP transport from SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465). */
export function smtpTransport(url: string): MailTransport {
  const transporter = createTransport({
    url,
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
        to: mail.to,
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

const MAX_QUEUE = 500;
const CONCURRENCY = 2;

/**
 * Sends mail in the background: `send()` only enqueues, so HTTP responses never wait for
 * (or reveal anything through the timing of) SMTP delivery. The queue is bounded; on
 * overflow mail is dropped and a warning logged. Failures are logged without addresses,
 * links or SMTP credentials.
 */
export class Mailer {
  private readonly queue: OutgoingMail[] = [];
  private active = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly log: MailLog,
  ) {}

  send(to: string, content: MailContent): void {
    if (this.closed) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.log.warn({}, 'mail queue full, dropping an email');
      return;
    }
    this.queue.push({ ...content, from: this.from, to });
    this.pump();
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

function render(subject: string, paragraphs: string[], action?: Action, footer: string[] = []): MailContent {
  const text = [...paragraphs, ...(action ? [`${action.label}:\n${action.url}`] : []), ...footer, `-- ${APP}`].join('\n\n');
  return { subject, text: `${text}\n`, html: layout(subject, paragraphs, action, footer) };
}

export function verifyEmailMail(link: string): MailContent {
  return render(
    `Confirm your email address for ${APP}`,
    ['Thanks for signing up! Please confirm your email address to activate your account. The link is valid for 24 hours.'],
    { label: 'Confirm email address', url: link },
    ['If you did not sign up, you can ignore this email; the account will not be activated.'],
  );
}

export function alreadyRegisteredMail(resetLink: string, loginLink: string): MailContent {
  return render(
    `You already have a ${APP} account`,
    [
      'Someone (hopefully you) tried to sign up with this email address, but an account already exists.',
      `You can log in at ${loginLink}. If you forgot your password, set a new one with the link below (valid for 1 hour).`,
    ],
    { label: 'Reset password', url: resetLink },
    ['If this was not you, you can ignore this email. Your account has not been changed.'],
  );
}

export function resetPasswordMail(link: string): MailContent {
  return render(
    `Reset your ${APP} password`,
    ['We received a request to reset your password. The link is valid for 1 hour and can be used once.'],
    { label: 'Choose a new password', url: link },
    ['If you did not request this, you can ignore this email. Your password has not been changed.'],
  );
}

export function accountDeletedMail(): MailContent {
  return render(`Your ${APP} account has been deleted`, [
    'Your account, all your sites and their analytics data have been deleted. Any subscription has been cancelled.',
    'Thanks for using ' + APP + '.',
  ]);
}
