// Per-application notifier state: rate limiters, SafeNet instances, the notification mailer.
// Kept in a WeakMap keyed by the AppContext so tests (several apps per process) stay isolated.
import { createTransport } from 'nodemailer';
import type { AppContext } from '../../context.js';
import { Mailer, safeHeaders, smtpTransport, type MailTransport } from '../../mail.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import { createSafeNet } from '../net/index.js';
import type { SafeNet } from '../types.js';
import type { OutgoingNotifyMail } from './context.js';
import { DeliveryError } from './http.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Test seams (fake network, captured mail, shorter timeouts). */
export interface NotifyOverrides {
  net?: (opts: { hostedMember: boolean }) => SafeNet;
  /** Transport for the operator mailer used by self-hosted e-mail channels (no SIGNUP_ENABLED). */
  mailTransport?: MailTransport;
  /** Replaces direct SMTP delivery (self-hosted channel-specific SMTP servers). */
  directSmtp?: (smtpUrl: string, from: string, mail: OutgoingNotifyMail) => Promise<void>;
  timeoutMs?: number;
}

export interface NotifyState {
  overrides: NotifyOverrides;
  /** Test sends per user: 5 / minute and 30 / hour. */
  testMinute: RateLimiter;
  testHour: RateLimiter;
  /** Verification mails per inviting user and day. */
  verifyDaily: RateLimiter;
  /** Deliveries per member and hour (MEMBER_NOTIFY_PER_HOUR). */
  memberHourly: RateLimiter;
  /** At most one "cap reached" warning per member and hour in the server log. */
  capWarned: RateLimiter;
  nets: Map<string, SafeNet>;
  selfHostedMailer: Mailer | null | undefined;
}

const states = new WeakMap<AppContext, NotifyState>();

export function notifyState(ctx: AppContext): NotifyState {
  let s = states.get(ctx);
  if (!s) {
    s = {
      overrides: {},
      testMinute: new RateLimiter(5, MIN, ctx.now, 20_000),
      testHour: new RateLimiter(30, HOUR, ctx.now, 20_000),
      verifyDaily: new RateLimiter(20, DAY, ctx.now, 20_000),
      memberHourly: new RateLimiter(ctx.config.uptime.memberNotifyPerHour, HOUR, ctx.now, 100_000),
      capWarned: new RateLimiter(1, HOUR, ctx.now, 100_000),
      nets: new Map(),
      selfHostedMailer: undefined,
    };
    states.set(ctx, s);
  }
  return s;
}

/** Install test seams (call right after building the app). */
export function setNotifyOverrides(ctx: AppContext, overrides: NotifyOverrides): void {
  const s = notifyState(ctx);
  s.overrides = { ...s.overrides, ...overrides };
  s.nets.clear();
  s.selfHostedMailer = undefined;
}

/** Hosted mode = public sign-up enabled (SPEC §6). */
export function isHosted(ctx: AppContext): boolean {
  return ctx.config.cloud.signupEnabled;
}

/** SafeNet for a channel: members in hosted mode get the strict policy (https only, no private targets). */
export function safeNetFor(ctx: AppContext, hostedMember: boolean): SafeNet {
  const s = notifyState(ctx);
  const key = hostedMember ? 'member' : 'operator';
  let net = s.nets.get(key);
  if (!net) {
    net = s.overrides.net ? s.overrides.net({ hostedMember }) : createSafeNet({ config: ctx.config.uptime, hostedMember });
    s.nets.set(key, net);
  }
  return net;
}

/**
 * The operator mailer for notification e-mail: the hosted-mode mailer (SIGNUP_ENABLED), or —
 * self-hosted — a mailer built from SMTP_URL + MAIL_FROM when both are configured.
 */
export function operatorMailer(ctx: AppContext): Mailer | null {
  if (ctx.mailer) return ctx.mailer;
  const s = notifyState(ctx);
  if (s.selfHostedMailer !== undefined) return s.selfHostedMailer;
  const { smtpUrl, mailFrom, smtpAllowInsecure, mailMaxPerHour } = ctx.config.cloud;
  const transport = s.overrides.mailTransport ?? (smtpUrl ? smtpTransport(smtpUrl, { allowInsecure: smtpAllowInsecure }) : null);
  s.selfHostedMailer = transport && mailFrom ? new Mailer(transport, mailFrom, ctx.log, { maxPerHour: mailMaxPerHour, now: ctx.now }) : null;
  return s.selfHostedMailer;
}

/** Queue one notification mail on the operator mailer (throws a retryable error when it is full). */
export function sendViaOperator(ctx: AppContext, mail: OutgoingNotifyMail, deliveryId: string): void {
  const mailer = operatorMailer(ctx);
  if (!mailer) throw new DeliveryError('e-mail is not configured on this server (SMTP_URL / MAIL_FROM)', { retryable: false });
  if (!mailer.hasCapacity()) throw new DeliveryError('outgoing mail limit reached (MAIL_MAX_PER_HOUR), will retry', { retryable: true });
  const r = mailer.send(mail.to, { template: `notify:${deliveryId}`, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
  if (r === 'rejected') throw new DeliveryError('outgoing mail queue full, will retry', { retryable: true });
}

/**
 * Self-hosted channel-specific SMTP server: nodemailer, but the TCP connection is opened by
 * SafeNet (policy-checked, pinned address); nodemailer performs implicit TLS / STARTTLS itself.
 */
export async function sendViaSmtp(ctx: AppContext, net: SafeNet, smtpUrl: string, from: string, mail: OutgoingNotifyMail, signal: AbortSignal): Promise<void> {
  const o = notifyState(ctx).overrides;
  if (o.directSmtp) return o.directSmtp(smtpUrl, from, mail);
  const u = new URL(smtpUrl);
  const secure = u.protocol === 'smtps:';
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  const transporter = createTransport({
    url: smtpUrl,
    ...(secure ? {} : { requireTLS: true }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
    getSocket(_opts: unknown, cb: (err: Error | null, socketOptions?: unknown) => void) {
      net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port, signal }).then(
        (r) => cb(null, { connection: r.socket }),
        (err: unknown) => cb(err instanceof Error ? err : new Error('connection failed')),
      );
    },
  } as Parameters<typeof createTransport>[0]);
  try {
    await transporter.sendMail({
      from,
      to: { name: '', address: mail.to },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: safeHeaders(mail.headers),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } finally {
    transporter.close();
  }
}
