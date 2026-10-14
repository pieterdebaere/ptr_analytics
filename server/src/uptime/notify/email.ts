// E-mail recipients: double opt-in (hosted members), one-click unsubscribe, delivery list.
//
// * Verification: 32 random bytes (base64url) in `PUBLIC_URL/api/notification-channels/verify?token=…`,
//   only sha256 stored, valid 7 days, single use. The link opens a page (GET, no state change: mail
//   link scanners must not subscribe anyone); the recipient confirms or declines with a POST.
//   The mail carries no member-chosen text beyond a short plain channel label (optInLabel).
// * Opt-outs: an address that unsubscribed from / declined a hosted member's channel never gets an
//   opt-in mail from that member again (notify_email_optouts); only the recipient re-subscribes.
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

/** `unsubscribed` also covers pending addresses that opted out of this owner's alerts (no opt-in mail is sent). */
export function recipientStatus(ctx: AppContext, channel: Pick<ChannelRow, 'id' | 'owner_id'>): RecipientStatus[] {
  return rows(ctx, channel.id).map((r) => ({
    address: r.address,
    verified: r.verified_at !== null,
    unsubscribed: r.unsubscribed_at !== null || (r.verified_at === null && optedOut(ctx, channel.owner_id, r.address)),
  }));
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

/**
 * The channel name as it may appear in an opt-in mail / page: the operator's mail server and
 * domain must not carry member-chosen free text to arbitrary addresses, so only a short plain
 * label (letters, digits, spaces, '-' and '_'; ≤ 40 characters, no URLs or domains) is shown,
 * anything else is omitted.
 */
export function optInLabel(name: string): string | null {
  const s = clean(name, 100);
  return /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(s) ? s : null;
}

function verificationMail(label: string | null, link: string) {
  return renderMail(
    'notify-verify',
    'Confirm uptime alerts from PTR Analytics',
    [
      'A user of PTR Analytics wants to send uptime monitoring alerts to this e-mail address' +
        (label ? ` (notification channel "${label}").` : '.'),
      'Nothing will be sent to you unless you confirm. The link is valid for 7 days. Every alert contains a link to unsubscribe. ' +
        'The page behind the link also lets you decline: you will then not be asked again.',
    ],
    { label: 'Confirm or decline', url: link },
    ['If you do not expect these alerts, ignore this message.'],
  );
}

type ChannelRef = Pick<ChannelRow, 'id' | 'name' | 'owner_id'>;

/** An address that unsubscribed from / declined a channel of this owner (hosted members only). */
function optedOut(ctx: AppContext, ownerId: number | null, address: string): boolean {
  if (ownerId === null) return false;
  return !!ctx.db.prepare('SELECT 1 FROM notify_email_optouts WHERE owner_id = ? AND address = ?').get(ownerId, address);
}

function recordOptOut(ctx: AppContext, ownerId: number | null, address: string, unsubTokenHash: string): void {
  if (ownerId === null) return;
  ctx.db
    .prepare(
      `INSERT INTO notify_email_optouts (owner_id, address, unsub_token_hash, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_id, address) DO UPDATE SET unsub_token_hash = excluded.unsub_token_hash`,
    )
    .run(ownerId, address, unsubTokenHash, ctx.now());
}

/** Send (or re-send) the opt-in mail for one recipient; false when not allowed / rate limited / no capacity. */
function sendVerification(ctx: AppContext, channel: ChannelRef, address: string, inviter: User): boolean {
  const now = ctx.now();
  const row = ctx.db.prepare('SELECT * FROM notify_email_recipients WHERE channel_id = ? AND address = ?').get(channel.id, address) as RecipientRow | undefined;
  if (!row) return false;
  if (row.verified_at !== null && row.unsubscribed_at === null) return false;
  // Unsubscribed or declined: only the recipient can undo that (never re-armed by the inviter).
  if (row.unsubscribed_at !== null || optedOut(ctx, channel.owner_id, address)) return false;
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
  mailer.send(address, verificationMail(optInLabel(channel.name), link));
  return true;
}

/**
 * Make the recipient table match `addresses`: removed addresses are deleted, new ones added
 * (verified at once when no opt-in is required, else a verification mail is sent — unless the
 * address opted out of this owner's alerts).
 */
export function syncRecipients(
  ctx: AppContext,
  channel: Pick<ChannelRow, 'id' | 'uid' | 'name' | 'owner_id'>,
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
        // Operators (no opt-in needed): a pending address becomes verified. An address that
        // unsubscribed stays unsubscribed — only the recipient re-subscribes.
        if (!opts.requireOptIn && row.verified_at === null && row.unsubscribed_at === null) {
          ctx.db.prepare('UPDATE notify_email_recipients SET verified_at = ? WHERE channel_id = ? AND address = ?').run(now, channel.id, addr);
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

/** Re-send opt-in mails to recipients that are still pending (never to unsubscribed / opted-out ones). */
export function resendVerification(ctx: AppContext, channel: ChannelRef, inviter: User): number {
  let sent = 0;
  for (const r of rows(ctx, channel.id)) {
    if (r.verified_at !== null || r.unsubscribed_at !== null) continue;
    if (sendVerification(ctx, channel, r.address, inviter)) sent++;
  }
  return sent;
}

interface PendingVerification {
  channel_id: number;
  channel_uid: string;
  owner_id: number | null;
  address: string;
  verify_expires_at: number | null;
  name: string;
  unsub_token_hash: string;
  unsub_token_enc: Buffer;
}

function pendingByToken(ctx: AppContext, token: string): PendingVerification | undefined {
  if (!TOKEN_RE.test(token)) return undefined;
  return ctx.db
    .prepare(
      `SELECT r.channel_id, c.uid AS channel_uid, c.owner_id, r.address, r.verify_expires_at, c.name, r.unsub_token_hash, r.unsub_token_enc
       FROM notify_email_recipients r JOIN notify_channels c ON c.id = r.channel_id AND c.deleted_at IS NULL
       WHERE r.verify_token_hash = ?`,
    )
    .get(sha256Hex(token)) as PendingVerification | undefined;
}

/** Read-only lookup for the confirmation page (GET): nothing changes, so link scanners subscribe nobody. */
export function verificationInfo(ctx: AppContext, token: string): { address: string; label: string | null } | null {
  const row = pendingByToken(ctx, token);
  if (!row || row.verify_expires_at === null || row.verify_expires_at <= ctx.now()) return null;
  return { address: row.address, label: optInLabel(row.name) };
}

/**
 * The recipient's answer (POST, token in the body). Single use; unknown/expired/used tokens → null.
 * `confirm`: the address receives alerts (and a previous opt-out of this owner is lifted).
 * `decline`: the address is marked unsubscribed and this owner can never send it an opt-in mail
 * again; the result carries the recipient's own token for an optional re-subscribe form.
 */
export function answerVerification(
  ctx: AppContext,
  token: string,
  answer: 'confirm' | 'decline',
): { address: string; label: string | null; unsubToken: string | null } | null {
  const now = ctx.now();
  return ctx.db.transaction(() => {
    const row = pendingByToken(ctx, token);
    if (!row) return null;
    // Single use, also when expired.
    ctx.db.prepare('UPDATE notify_email_recipients SET verify_token_hash = NULL, verify_expires_at = NULL WHERE channel_id = ? AND address = ?').run(row.channel_id, row.address);
    if (row.verify_expires_at === null || row.verify_expires_at <= now) return null;
    let unsubToken: string | null = null;
    if (answer === 'confirm') {
      ctx.db
        .prepare('UPDATE notify_email_recipients SET verified_at = ?, unsubscribed_at = NULL WHERE channel_id = ? AND address = ?')
        .run(now, row.channel_id, row.address);
      if (row.owner_id !== null) ctx.db.prepare('DELETE FROM notify_email_optouts WHERE owner_id = ? AND address = ?').run(row.owner_id, row.address);
    } else {
      ctx.db
        .prepare('UPDATE notify_email_recipients SET unsubscribed_at = coalesce(unsubscribed_at, ?) WHERE channel_id = ? AND address = ?')
        .run(now, row.channel_id, row.address);
      recordOptOut(ctx, row.owner_id, row.address, row.unsub_token_hash);
      try {
        unsubToken = ctx.secretBox().open(row.unsub_token_enc, unsubAad(row.channel_uid, row.address))['t'] ?? null;
      } catch {
        unsubToken = null;
      }
    }
    return { address: row.address, label: optInLabel(row.name), unsubToken };
  })();
}

interface UnsubRow {
  channel_id: number;
  address: string;
  owner_id: number | null;
}

function recipientByUnsubToken(ctx: AppContext, hash: string): UnsubRow | undefined {
  return ctx.db
    .prepare(
      `SELECT r.channel_id, r.address, c.owner_id FROM notify_email_recipients r
       JOIN notify_channels c ON c.id = r.channel_id WHERE r.unsub_token_hash = ?`,
    )
    .get(hash) as UnsubRow | undefined;
}

/**
 * Unsubscribe (idempotent: also answers true for a token whose recipient row is gone but whose
 * opt-out is recorded). Unknown tokens → false. A hosted member's channel records an opt-out, so
 * the inviter cannot re-arm the opt-in (removing / re-adding the address or a new channel included).
 */
export function unsubscribeToken(ctx: AppContext, token: string): boolean {
  if (!TOKEN_RE.test(token)) return false;
  const hash = sha256Hex(token);
  return ctx.db.transaction(() => {
    const r = recipientByUnsubToken(ctx, hash);
    if (!r) return !!ctx.db.prepare('SELECT 1 FROM notify_email_optouts WHERE unsub_token_hash = ?').get(hash);
    ctx.db
      .prepare(
        `UPDATE notify_email_recipients SET unsubscribed_at = coalesce(unsubscribed_at, ?), verify_token_hash = NULL, verify_expires_at = NULL
         WHERE channel_id = ? AND address = ?`,
      )
      .run(ctx.now(), r.channel_id, r.address);
    recordOptOut(ctx, r.owner_id, r.address, hash);
    return true;
  })();
}

/**
 * Re-subscribe — only the recipient can (POST with their own unsubscribe token in the body).
 * 'resubscribed': alerts of that channel are delivered again; 'allowed': the recipient row is
 * gone, but the owner may invite the address again (the opt-out is lifted); null: unknown token.
 */
export function resubscribeToken(ctx: AppContext, token: string): 'resubscribed' | 'allowed' | null {
  if (!TOKEN_RE.test(token)) return null;
  const hash = sha256Hex(token);
  const now = ctx.now();
  return ctx.db.transaction(() => {
    const r = recipientByUnsubToken(ctx, hash);
    if (r) {
      ctx.db
        .prepare('UPDATE notify_email_recipients SET verified_at = coalesce(verified_at, ?), unsubscribed_at = NULL WHERE channel_id = ? AND address = ?')
        .run(now, r.channel_id, r.address);
      if (r.owner_id !== null) ctx.db.prepare('DELETE FROM notify_email_optouts WHERE owner_id = ? AND address = ?').run(r.owner_id, r.address);
      return 'resubscribed';
    }
    const gone = ctx.db.prepare('DELETE FROM notify_email_optouts WHERE unsub_token_hash = ?').run(hash);
    return gone.changes > 0 ? 'allowed' : null;
  })();
}
