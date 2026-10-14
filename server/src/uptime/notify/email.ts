// E-mail recipients: double opt-in (hosted members), one-click unsubscribe, delivery list.
//
// * Verification: 32 random bytes (base64url) in `PUBLIC_URL/api/notification-channels/verify?token=…`,
//   only sha256 stored, valid 7 days, single use. The mail says who added the address.
// * Unsubscribe: a per-recipient token (sha256 stored for lookup; the token itself is kept
//   encrypted because it goes into every notification mail). Unsubscribing is idempotent.
// * Rate limits: one verification mail per recipient per 10 minutes, 20 per inviting user per
//   day, plus the global mail caps of the operator mailer.
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { User } from '../../data/users.js';
import { sha256Hex } from '../../lib/ids.js';
import { renderMail } from '../../mail.js';
import { clean } from './render.js';
import type { ChannelRow } from './channels.js';
import type { EmailRecipient } from './context.js';
import { notifyState, operatorMailer } from './state.js';

const MIN = 60_000;
export const VERIFY_TTL_MS = 7 * 24 * 60 * MIN;
const VERIFY_RESEND_MS = 10 * MIN;

interface RecipientRow {
  channel_id: number;
  address: string;
  verified_at: number | null;
  unsubscribed_at: number | null;
  verify_token_hash: string | null;
  verify_expires_at: number | null;
  verify_sent_at: number | null;
  unsub_token_hash: string;
  unsub_token_enc: Buffer;
  created_at: number;
}

export interface RecipientStatus {
  address: string;
  verified: boolean;
  unsubscribed: boolean;
}

const newToken = (): string => randomBytes(32).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function unsubAad(channelUid: string, address: string): string {
  return `notify-unsub:${channelUid}:${address}`;
}

export function verifyLink(ctx: AppContext, token: string): string | null {
  return ctx.config.publicUrl ? `${ctx.config.publicUrl}/api/notification-channels/verify?token=${encodeURIComponent(token)}` : null;
}

export function unsubscribeLink(ctx: AppContext, token: string): string | null {
  return ctx.config.publicUrl ? `${ctx.config.publicUrl}/api/notification-channels/unsubscribe?token=${encodeURIComponent(token)}` : null;
}

function rows(ctx: AppContext, channelId: number): RecipientRow[] {
  return ctx.db.prepare('SELECT * FROM notify_email_recipients WHERE channel_id = ? ORDER BY created_at, address').all(channelId) as RecipientRow[];
}

export function recipientStatus(ctx: AppContext, channelId: number): RecipientStatus[] {
  return rows(ctx, channelId).map((r) => ({ address: r.address, verified: r.verified_at !== null, unsubscribed: r.unsubscribed_at !== null }));
}

/** Confirmed and subscribed recipients with their unsubscribe links. */
export function deliveryRecipients(ctx: AppContext, channel: Pick<ChannelRow, 'id' | 'uid'>): EmailRecipient[] {
  const out: EmailRecipient[] = [];
  for (const r of rows(ctx, channel.id)) {
    if (r.verified_at === null || r.unsubscribed_at !== null) continue;
    let unsubscribeUrl: string | null = null;
    try {
      const token = ctx.secretBox().open(r.unsub_token_enc, unsubAad(channel.uid, r.address))['t'];
      if (token) unsubscribeUrl = unsubscribeLink(ctx, token);
    } catch {
      unsubscribeUrl = null;
    }
    out.push({ address: r.address, unsubscribeUrl });
  }
  return out;
}

function verificationMail(inviter: string, channelName: string, link: string) {
  return renderMail(
    'notify-verify',
    'Confirm uptime alerts from PTR Analytics',
    [
      `${inviter} wants to send uptime monitoring alerts to this e-mail address through PTR Analytics ` +
        `(notification channel "${channelName}").`,
      'Nothing will be sent to you unless you confirm. The link is valid for 7 days. Every alert contains a link to unsubscribe.',
    ],
    { label: 'Confirm and receive alerts', url: link },
    ['If you do not know this person or do not want these e-mails, ignore this message.'],
  );
}

/** Send (or re-send) the opt-in mail for one recipient; false when rate limited / no capacity. */
function sendVerification(ctx: AppContext, channel: Pick<ChannelRow, 'id' | 'name'>, address: string, inviter: User): boolean {
  const now = ctx.now();
  const row = ctx.db.prepare('SELECT * FROM notify_email_recipients WHERE channel_id = ? AND address = ?').get(channel.id, address) as RecipientRow | undefined;
  if (!row) return false;
  if (row.verified_at !== null && row.unsubscribed_at === null) return false;
  if (row.verify_sent_at !== null && now - row.verify_sent_at < VERIFY_RESEND_MS) return false;
  const mailer = operatorMailer(ctx);
  if (!mailer || !mailer.hasCapacity()) return false;
  if (!notifyState(ctx).verifyDaily.hit(String(inviter.id))) return false;
  const token = newToken();
  const link = verifyLink(ctx, token);
  if (!link) return false;
  ctx.db
    .prepare('UPDATE notify_email_recipients SET verify_token_hash = ?, verify_expires_at = ?, verify_sent_at = ? WHERE channel_id = ? AND address = ?')
    .run(sha256Hex(token), now + VERIFY_TTL_MS, now, channel.id, address);
  mailer.send(address, verificationMail(inviter.email, clean(channel.name, 100), link));
  return true;
}

/**
 * Make the recipient table match `addresses`: removed addresses are deleted, new ones added
 * (verified at once when no opt-in is required, else a verification mail is sent).
 */
export function syncRecipients(
  ctx: AppContext,
  channel: Pick<ChannelRow, 'id' | 'uid' | 'name'>,
  addresses: string[],
  opts: { requireOptIn: boolean; inviter: User },
): void {
  const now = ctx.now();
  const existing = new Map(rows(ctx, channel.id).map((r) => [r.address, r]));
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  const added: string[] = [];
  ctx.db.transaction(() => {
    for (const addr of existing.keys()) {
      if (!wanted.has(addr)) ctx.db.prepare('DELETE FROM notify_email_recipients WHERE channel_id = ? AND address = ?').run(channel.id, addr);
    }
    for (const addr of wanted) {
      const row = existing.get(addr);
      if (row) {
        // Operators (no opt-in needed) adding an address back re-subscribes it.
        if (!opts.requireOptIn && (row.verified_at === null || row.unsubscribed_at !== null)) {
          ctx.db.prepare('UPDATE notify_email_recipients SET verified_at = coalesce(verified_at, ?) WHERE channel_id = ? AND address = ?').run(now, channel.id, addr);
        }
        continue;
      }
      const unsub = newToken();
      ctx.db
        .prepare(
          `INSERT INTO notify_email_recipients (channel_id, address, verified_at, unsub_token_hash, unsub_token_enc, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(channel.id, addr, opts.requireOptIn ? null : now, sha256Hex(unsub), ctx.secretBox().seal({ t: unsub }, unsubAad(channel.uid, addr)), now);
      added.push(addr);
    }
  })();
  if (opts.requireOptIn) for (const addr of added) sendVerification(ctx, channel, addr, opts.inviter);
}

/** Re-send opt-in mails to recipients that are not (or no longer) confirmed. */
export function resendVerification(ctx: AppContext, channel: Pick<ChannelRow, 'id' | 'name'>, inviter: User): number {
  let sent = 0;
  for (const r of rows(ctx, channel.id)) {
    if (r.verified_at !== null && r.unsubscribed_at === null) continue;
    if (sendVerification(ctx, channel, r.address, inviter)) sent++;
  }
  return sent;
}

/** Confirm a recipient. Single use; unknown/expired/used tokens → null. */
export function confirmToken(ctx: AppContext, token: string): { address: string; channelName: string } | null {
  if (!TOKEN_RE.test(token)) return null;
  const now = ctx.now();
  const hash = sha256Hex(token);
  return ctx.db.transaction(() => {
    const row = ctx.db
      .prepare(
        `SELECT r.address, r.channel_id, r.verify_expires_at, c.name FROM notify_email_recipients r
         JOIN notify_channels c ON c.id = r.channel_id AND c.deleted_at IS NULL
         WHERE r.verify_token_hash = ?`,
      )
      .get(hash) as { address: string; channel_id: number; verify_expires_at: number | null; name: string } | undefined;
    if (!row) return null;
    // Single use, also when expired.
    ctx.db.prepare('UPDATE notify_email_recipients SET verify_token_hash = NULL, verify_expires_at = NULL WHERE channel_id = ? AND address = ?').run(row.channel_id, row.address);
    if (row.verify_expires_at === null || row.verify_expires_at <= now) return null;
    ctx.db
      .prepare('UPDATE notify_email_recipients SET verified_at = ?, unsubscribed_at = NULL WHERE channel_id = ? AND address = ?')
      .run(now, row.channel_id, row.address);
    return { address: row.address, channelName: clean(row.name, 100) };
  })();
}

/** Unsubscribe (idempotent). Unknown tokens → false. */
export function unsubscribeToken(ctx: AppContext, token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const r = ctx.db
    .prepare('UPDATE notify_email_recipients SET unsubscribed_at = coalesce(unsubscribed_at, ?) WHERE unsub_token_hash = ?')
    .run(ctx.now(), sha256Hex(token));
  return r.changes > 0;
}
