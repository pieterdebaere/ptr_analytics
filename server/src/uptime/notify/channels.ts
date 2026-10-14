// Notification channel storage (notify_channels, monitor_channels links) and tenancy.
//
// Ownership (SPEC §8.1): members own their channels (`owner_id = user.id`); channels created by
// admins are operator channels (`owner_id = NULL`), like admin-created sites, so they can be
// linked to operator monitors. Admins and viewers see operator channels plus their own; members
// only their own; viewers are read-only. Anything else answers 404 (no existence oracle).
import type { AppContext } from '../../context.js';
import type { User } from '../../data/users.js';
import { forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { generateSiteId } from '../../lib/ids.js';
import { isHosted } from './state.js';

export interface ChannelRow {
  id: number;
  uid: string;
  owner_id: number | null;
  type: string;
  name: string;
  config: string;
  secrets: Buffer | null;
  is_default: number;
  active: number;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const UID_RE = /^[a-z0-9]{12}$/;
/** Consecutive final delivery failures after which a channel is disabled. */
export const AUTO_DISABLE_AFTER = 10;
/** Links per monitor for members (ANALYSIS §8.6). */
export const MEMBER_CHANNELS_PER_MONITOR = 5;

export function secretsAad(uid: string): string {
  return `channel:${uid}`;
}

export function parseConfig(row: Pick<ChannelRow, 'config'>): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(row.config);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function openSecrets(ctx: AppContext, row: Pick<ChannelRow, 'uid' | 'secrets'>): Record<string, string> {
  if (!row.secrets || row.secrets.length === 0) return {};
  return ctx.secretBox().open(row.secrets, secretsAad(row.uid));
}

export function sealSecrets(ctx: AppContext, uid: string, secrets: Record<string, string>): Buffer | null {
  return Object.keys(secrets).length === 0 ? null : ctx.secretBox().seal(secrets, secretsAad(uid));
}

/** The owner_id new channels of this user get. */
export function ownerFor(user: User): number | null {
  return user.role === 'member' ? user.id : null;
}

/** Members in hosted mode: strict validation, SafeNet member policy, limits, double opt-in. */
export function isHostedMemberUser(ctx: AppContext, user: User): boolean {
  return isHosted(ctx) && user.role === 'member';
}

export function canSee(user: User, row: Pick<ChannelRow, 'owner_id'>): boolean {
  if (user.role === 'member') return row.owner_id === user.id;
  if (user.role === 'admin' || user.role === 'viewer') return row.owner_id === null || row.owner_id === user.id;
  return false;
}

export function byUid(ctx: AppContext, uid: string): ChannelRow | undefined {
  if (!UID_RE.test(uid)) return undefined;
  return ctx.db.prepare('SELECT * FROM notify_channels WHERE uid = ? AND deleted_at IS NULL').get(uid) as ChannelRow | undefined;
}

/** Load a channel the user may see (read) or change (manage), else 404 / 403. */
export function channelFor(ctx: AppContext, user: User | null, uid: unknown, access: 'read' | 'manage'): ChannelRow {
  if (!user) throw unauthorized();
  if (access === 'manage' && user.role === 'viewer') throw forbidden('admin role required');
  const row = typeof uid === 'string' ? byUid(ctx, uid) : undefined;
  if (!row || !canSee(user, row)) throw notFound('notification channel not found');
  return row;
}

export function listVisible(ctx: AppContext, user: User): ChannelRow[] {
  if (user.role === 'member') {
    return ctx.db.prepare('SELECT * FROM notify_channels WHERE owner_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, id').all(user.id) as ChannelRow[];
  }
  return ctx.db
    .prepare('SELECT * FROM notify_channels WHERE (owner_id IS NULL OR owner_id = ?) AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, id')
    .all(user.id) as ChannelRow[];
}

export function countOwned(ctx: AppContext, ownerId: number): number {
  return (ctx.db.prepare('SELECT count(*) AS n FROM notify_channels WHERE owner_id = ? AND deleted_at IS NULL').get(ownerId) as { n: number }).n;
}

export function newUid(ctx: AppContext): string {
  for (;;) {
    const uid = generateSiteId();
    if (!ctx.db.prepare('SELECT 1 FROM notify_channels WHERE uid = ?').get(uid)) return uid;
  }
}

export function monitorCounts(ctx: AppContext, ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const rows = ctx.db
    .prepare(
      `SELECT mc.channel_id AS id, count(*) AS n FROM monitor_channels mc
       JOIN monitors m ON m.id = mc.monitor_id AND m.deleted_at IS NULL
       WHERE mc.channel_id IN (${ids.map(() => '?').join(',')}) GROUP BY mc.channel_id`,
    )
    .all(...ids) as Array<{ id: number; n: number }>;
  for (const r of rows) out.set(r.id, r.n);
  return out;
}

/**
 * Link the channel to every live monitor of the same owner (monitors.site_id → sites.owner_id;
 * operator channels → operator sites). Members: monitors already linked to 5 channels are skipped.
 * Returns the number of new links.
 */
export function applyToExisting(ctx: AppContext, channel: Pick<ChannelRow, 'id' | 'owner_id'>, memberLimit: boolean): number {
  const limit = memberLimit ? `AND (SELECT count(*) FROM monitor_channels x WHERE x.monitor_id = m.id) < ${MEMBER_CHANNELS_PER_MONITOR}` : '';
  return ctx.db
    .prepare(
      `INSERT OR IGNORE INTO monitor_channels (monitor_id, channel_id)
       SELECT m.id, ? FROM monitors m JOIN sites s ON s.id = m.site_id
       WHERE m.deleted_at IS NULL AND s.deleted_at IS NULL AND s.owner_id IS ? ${limit}`,
    )
    .run(channel.id, channel.owner_id).changes;
}

/** Soft delete: hidden at once, secrets dropped, links and pending deliveries removed. */
export function softDelete(ctx: AppContext, row: ChannelRow): void {
  const now = ctx.now();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE notify_channels SET deleted_at = ?, active = 0, is_default = 0, secrets = NULL, updated_at = ? WHERE id = ?').run(now, now, row.id);
    ctx.db.prepare('DELETE FROM monitor_channels WHERE channel_id = ?').run(row.id);
    ctx.db.prepare('DELETE FROM notify_outbox WHERE channel_id = ?').run(row.id);
    ctx.db.prepare('DELETE FROM notify_email_recipients WHERE channel_id = ?').run(row.id);
  })();
}
