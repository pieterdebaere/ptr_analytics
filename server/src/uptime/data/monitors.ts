// Monitor repository (docs/SPEC.md §8.2/8.3). Monitors belong to a site: a monitor is only
// "live" while it is not soft-deleted and its site is not soft-deleted.
import type { DB } from '../../db/index.js';
import { generateSiteId } from '../../lib/ids.js';

export const MONITOR_UID_RE = /^[a-z0-9]{12}$/;

export interface MonitorRecord {
  id: number;
  uid: string;
  siteId: string;
  parentId: number | null;
  type: string;
  name: string;
  description: string | null;
  active: boolean;
  intervalS: number;
  retryIntervalS: number;
  maxRetries: number;
  resendEvery: number;
  timeoutMs: number;
  upsideDown: boolean;
  certNotify: boolean;
  domainNotify: boolean;
  config: Record<string, unknown>;
  secrets: Buffer | null;
  secretKeys: string[];
  pushTokenHash: string | null;
  publicId: string | null;
  position: number;
  manualStatus: number | null;
  manualMsg: string | null;
  createdAt: number;
  updatedAt: number;
  /** From the site. */
  siteName: string;
  ownerId: number | null;
  siteSuspended: boolean;
}

export interface MonitorRow {
  id: number;
  uid: string;
  site_id: string;
  parent_id: number | null;
  type: string;
  name: string;
  description: string | null;
  active: number;
  interval_s: number;
  retry_interval_s: number;
  max_retries: number;
  resend_every: number;
  timeout_ms: number;
  upside_down: number;
  cert_notify: number;
  domain_notify: number;
  config: string;
  secrets: Buffer | null;
  secret_keys: string | null;
  push_token_hash: string | null;
  public_id: string | null;
  position: number;
  manual_status: number | null;
  manual_msg: string | null;
  created_at: number;
  updated_at: number;
  site_name: string;
  owner_id: number | null;
  suspended: number;
}

export interface StateRecord {
  status: number;
  retries: number;
  failedSinceNotify: number;
  lastCheckAt: number | null;
  lastChangeAt: number | null;
  lastPushAt: number | null;
  lastLatencyMs: number | null;
  lastMsg: string | null;
  openOutageId: number | null;
}

interface StateRow {
  monitor_id: number;
  status: number;
  retries: number;
  failed_since_notify: number;
  last_check_at: number | null;
  last_change_at: number | null;
  last_push_at: number | null;
  last_latency_ms: number | null;
  last_msg: string | null;
  open_outage_id: number | null;
}

export interface MonitorTag {
  uid: string;
  name: string;
  color: string;
  value: string;
}

export interface TlsRecord {
  checkedAt: number | null;
  valid: boolean;
  hostnameOk: boolean;
  subject: string | null;
  issuer: string | null;
  notBefore: number | null;
  notAfter: number | null;
  fingerprint256: string | null;
}

export function parseJsonObject(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseStringArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const toMonitor = (r: MonitorRow): MonitorRecord => ({
  id: r.id,
  uid: r.uid,
  siteId: r.site_id,
  parentId: r.parent_id,
  type: r.type,
  name: r.name,
  description: r.description,
  active: r.active === 1,
  intervalS: r.interval_s,
  retryIntervalS: r.retry_interval_s,
  maxRetries: r.max_retries,
  resendEvery: r.resend_every,
  timeoutMs: r.timeout_ms,
  upsideDown: r.upside_down === 1,
  certNotify: r.cert_notify === 1,
  domainNotify: r.domain_notify === 1,
  config: parseJsonObject(r.config),
  secrets: r.secrets,
  secretKeys: parseStringArray(r.secret_keys),
  pushTokenHash: r.push_token_hash,
  publicId: r.public_id,
  position: r.position,
  manualStatus: r.manual_status,
  manualMsg: r.manual_msg,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  siteName: r.site_name,
  ownerId: r.owner_id,
  siteSuspended: r.suspended === 1,
});

const toState = (r: StateRow): StateRecord => ({
  status: r.status,
  retries: r.retries,
  failedSinceNotify: r.failed_since_notify,
  lastCheckAt: r.last_check_at,
  lastChangeAt: r.last_change_at,
  lastPushAt: r.last_push_at,
  lastLatencyMs: r.last_latency_ms,
  lastMsg: r.last_msg,
  openOutageId: r.open_outage_id,
});

export const MONITOR_SELECT = `SELECT m.*, s.name AS site_name, s.owner_id AS owner_id, s.suspended AS suspended
  FROM monitors m JOIN sites s ON s.id = m.site_id`;
/** Live monitor on a live site. */
export const LIVE = 'm.deleted_at IS NULL AND s.deleted_at IS NULL';

export interface MonitorInsert {
  siteId: string;
  parentId: number | null;
  type: string;
  name: string;
  description: string | null;
  active: boolean;
  intervalS: number;
  retryIntervalS: number;
  maxRetries: number;
  resendEvery: number;
  timeoutMs: number;
  upsideDown: boolean;
  certNotify: boolean;
  domainNotify: boolean;
  config: Record<string, unknown>;
  secrets: Buffer | null;
  secretKeys: string[];
  pushTokenHash: string | null;
}

export type MonitorPatch = Partial<Omit<MonitorInsert, 'siteId'>>;

const PATCH_COLUMNS: Record<keyof MonitorPatch, string> = {
  parentId: 'parent_id',
  type: 'type',
  name: 'name',
  description: 'description',
  active: 'active',
  intervalS: 'interval_s',
  retryIntervalS: 'retry_interval_s',
  maxRetries: 'max_retries',
  resendEvery: 'resend_every',
  timeoutMs: 'timeout_ms',
  upsideDown: 'upside_down',
  certNotify: 'cert_notify',
  domainNotify: 'domain_notify',
  config: 'config',
  secrets: 'secrets',
  secretKeys: 'secret_keys',
  pushTokenHash: 'push_token_hash',
};

function dbValue(key: keyof MonitorPatch, v: unknown): unknown {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (key === 'config') return JSON.stringify(v);
  if (key === 'secretKeys') return (v as string[]).length > 0 ? JSON.stringify(v) : null;
  return v;
}

export class MonitorRepo {
  constructor(private readonly db: DB) {}

  byUid(uid: string): MonitorRecord | null {
    if (!MONITOR_UID_RE.test(uid)) return null;
    const r = this.db.prepare(`${MONITOR_SELECT} WHERE m.uid = ? AND ${LIVE}`).get(uid) as MonitorRow | undefined;
    return r ? toMonitor(r) : null;
  }

  byId(id: number): MonitorRecord | null {
    const r = this.db.prepare(`${MONITOR_SELECT} WHERE m.id = ? AND ${LIVE}`).get(id) as MonitorRow | undefined;
    return r ? toMonitor(r) : null;
  }

  byIds(ids: readonly number[]): MonitorRecord[] {
    if (ids.length === 0) return [];
    const out: MonitorRecord[] = [];
    for (const chunk of chunks(ids, 500)) {
      const rows = this.db
        .prepare(`${MONITOR_SELECT} WHERE m.id IN (${chunk.map(() => '?').join(',')}) AND ${LIVE}`)
        .all(...chunk) as MonitorRow[];
      out.push(...rows.map(toMonitor));
    }
    return out;
  }

  /** Live monitors by uid (unknown uids are left out). */
  byUids(uids: readonly string[]): MonitorRecord[] {
    const valid = uids.filter((u) => MONITOR_UID_RE.test(u));
    if (valid.length === 0) return [];
    const out: MonitorRecord[] = [];
    for (const chunk of chunks(valid, 500)) {
      const rows = this.db
        .prepare(`${MONITOR_SELECT} WHERE m.uid IN (${chunk.map(() => '?').join(',')}) AND ${LIVE}`)
        .all(...chunk) as MonitorRow[];
      out.push(...rows.map(toMonitor));
    }
    return out;
  }

  /** Live monitors of the given sites, or of every live site when `siteIds` is null. */
  list(siteIds: readonly string[] | null): MonitorRecord[] {
    if (siteIds === null) {
      return (this.db.prepare(`${MONITOR_SELECT} WHERE ${LIVE} ORDER BY m.site_id, m.position, m.id`).all() as MonitorRow[]).map(toMonitor);
    }
    const out: MonitorRecord[] = [];
    for (const chunk of chunks(siteIds, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(`${MONITOR_SELECT} WHERE m.site_id IN (${chunk.map(() => '?').join(',')}) AND ${LIVE} ORDER BY m.site_id, m.position, m.id`)
        .all(...chunk) as MonitorRow[];
      out.push(...rows.map(toMonitor));
    }
    return out;
  }

  countBySite(siteId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM monitors WHERE site_id = ? AND deleted_at IS NULL').get(siteId) as { n: number }).n;
  }

  /** Monitors the engine schedules: live, active, on a live and not suspended site. */
  schedulable(): MonitorRecord[] {
    return (
      this.db.prepare(`${MONITOR_SELECT} WHERE ${LIVE} AND m.active = 1 AND s.suspended = 0 ORDER BY m.id`).all() as MonitorRow[]
    ).map(toMonitor);
  }

  /** Children (live) of a group monitor. */
  children(parentId: number): MonitorRecord[] {
    return (this.db.prepare(`${MONITOR_SELECT} WHERE m.parent_id = ? AND ${LIVE} ORDER BY m.position, m.id`).all(parentId) as MonitorRow[]).map(
      toMonitor,
    );
  }

  /** Parent ids of every live monitor (maintenance inheritance, cycle checks). */
  parentMap(): Map<number, number | null> {
    const rows = this.db.prepare('SELECT id, parent_id FROM monitors WHERE deleted_at IS NULL').all() as Array<{ id: number; parent_id: number | null }>;
    return new Map(rows.map((r) => [r.id, r.parent_id]));
  }

  insert(m: MonitorInsert, now: number): MonitorRecord {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO monitors (uid, site_id, parent_id, type, name, description, active, interval_s, retry_interval_s,
         max_retries, resend_every, timeout_ms, upside_down, cert_notify, domain_notify, config, secrets, secret_keys,
         push_token_hash, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM monitors WHERE site_id = ?), ?, ?)`,
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const uid = generateSiteId();
      const res = stmt.run(
        uid,
        m.siteId,
        m.parentId,
        m.type,
        m.name,
        m.description,
        m.active ? 1 : 0,
        m.intervalS,
        m.retryIntervalS,
        m.maxRetries,
        m.resendEvery,
        m.timeoutMs,
        m.upsideDown ? 1 : 0,
        m.certNotify ? 1 : 0,
        m.domainNotify ? 1 : 0,
        JSON.stringify(m.config),
        m.secrets,
        m.secretKeys.length > 0 ? JSON.stringify(m.secretKeys) : null,
        m.pushTokenHash,
        m.siteId,
        now,
        now,
      );
      if (res.changes === 1) {
        const id = Number(res.lastInsertRowid);
        this.db.prepare('INSERT OR IGNORE INTO monitor_state (monitor_id) VALUES (?)').run(id);
        const rec = this.byId(id);
        if (!rec) throw new Error('monitor vanished after insert');
        return rec;
      }
    }
    throw new Error('could not allocate a unique monitor uid');
  }

  update(id: number, patch: MonitorPatch, now: number): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(patch) as Array<keyof MonitorPatch>) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${PATCH_COLUMNS[key]} = ?`);
      params.push(dbValue(key, v));
    }
    sets.push('updated_at = ?');
    params.push(now, id);
    this.db.prepare(`UPDATE monitors SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...params);
  }

  /** Re-encrypted secrets (cloning) or rotated envelopes. */
  setSecrets(id: number, secrets: Buffer | null, keys: string[], now: number): void {
    this.update(id, { secrets, secretKeys: keys }, now);
  }

  setActive(id: number, active: boolean, now: number): void {
    this.db.prepare('UPDATE monitors SET active = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(active ? 1 : 0, now, id);
  }

  setPushTokenHash(id: number, hash: string | null, now: number): void {
    this.db.prepare('UPDATE monitors SET push_token_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, id);
  }

  setPublicId(id: number, publicId: string | null, now: number): boolean {
    try {
      this.db.prepare('UPDATE monitors SET public_id = ?, updated_at = ? WHERE id = ?').run(publicId, now, id);
      return true;
    } catch {
      return false; // unique collision (astronomically unlikely); the caller retries
    }
  }

  setManual(id: number, status: number | null, msg: string | null, now: number): void {
    this.db.prepare('UPDATE monitors SET manual_status = ?, manual_msg = ?, updated_at = ? WHERE id = ?').run(status, msg, now, id);
  }

  /** Push monitor by sha256(token) (live, active, live and not suspended site). */
  byPushTokenHash(hash: string): MonitorRecord | null {
    const r = this.db
      .prepare(`${MONITOR_SELECT} WHERE m.push_token_hash = ? AND ${LIVE}`)
      .get(hash) as MonitorRow | undefined;
    return r ? toMonitor(r) : null;
  }

  /**
   * Soft delete: hidden at once; children are detached; links are removed. Heartbeats, stats,
   * events and outages are purged later in chunks (uptime/data/purge.ts).
   */
  softDelete(id: number, now: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db
        .prepare('UPDATE monitors SET deleted_at = ?, active = 0, push_token_hash = NULL, public_id = NULL WHERE id = ? AND deleted_at IS NULL')
        .run(now, id).changes;
      if (changed === 0) return false;
      this.db.prepare('UPDATE monitors SET parent_id = NULL, updated_at = ? WHERE parent_id = ?').run(now, id);
      unlinkMonitor(this.db, id);
      return true;
    })();
  }

  /** Soft-delete every monitor of a site (site deletion). */
  softDeleteBySite(siteId: string, now: number): number {
    const ids = (this.db.prepare('SELECT id FROM monitors WHERE site_id = ? AND deleted_at IS NULL').all(siteId) as Array<{ id: number }>).map(
      (r) => r.id,
    );
    for (const id of ids) this.softDelete(id, now);
    return ids.length;
  }

  // ---- state ----

  states(ids: readonly number[]): Map<number, StateRecord> {
    const out = new Map<number, StateRecord>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(`SELECT * FROM monitor_state WHERE monitor_id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as StateRow[];
      for (const r of rows) out.set(r.monitor_id, toState(r));
    }
    return out;
  }

  state(id: number): StateRecord | null {
    const r = this.db.prepare('SELECT * FROM monitor_state WHERE monitor_id = ?').get(id) as StateRow | undefined;
    return r ? toState(r) : null;
  }

  tls(ids: readonly number[]): Map<number, TlsRecord> {
    const out = new Map<number, TlsRecord>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT monitor_id, checked_at, valid, hostname_ok, subject, issuer, not_before, not_after, fingerprint256
           FROM monitor_tls WHERE monitor_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as Array<{
        monitor_id: number;
        checked_at: number | null;
        valid: number | null;
        hostname_ok: number | null;
        subject: string | null;
        issuer: string | null;
        not_before: number | null;
        not_after: number | null;
        fingerprint256: string | null;
      }>;
      for (const r of rows) {
        out.set(r.monitor_id, {
          checkedAt: r.checked_at,
          valid: r.valid === 1,
          hostnameOk: r.hostname_ok === 1,
          subject: r.subject,
          issuer: r.issuer,
          notBefore: r.not_before,
          notAfter: r.not_after,
          fingerprint256: r.fingerprint256,
        });
      }
    }
    return out;
  }

  // ---- tags ----

  tagsFor(ids: readonly number[]): Map<number, MonitorTag[]> {
    const out = new Map<number, MonitorTag[]>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT mt.monitor_id, t.uid, t.name, t.color, mt.value FROM monitor_tags mt JOIN tags t ON t.id = mt.tag_id
           WHERE mt.monitor_id IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name COLLATE NOCASE, mt.value`,
        )
        .all(...chunk) as Array<{ monitor_id: number } & MonitorTag>;
      for (const r of rows) {
        const list = out.get(r.monitor_id) ?? [];
        list.push({ uid: r.uid, name: r.name, color: r.color, value: r.value });
        out.set(r.monitor_id, list);
      }
    }
    return out;
  }

  setTags(monitorId: number, tags: ReadonlyArray<{ tagId: number; value: string }>): void {
    this.db.prepare('DELETE FROM monitor_tags WHERE monitor_id = ?').run(monitorId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO monitor_tags (monitor_id, tag_id, value) VALUES (?, ?, ?)');
    for (const t of tags) ins.run(monitorId, t.tagId, t.value);
  }

  // ---- notification channels (table owned by the notifications module; we only link) ----

  channelUidsFor(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const chunk of chunks(ids, 500)) {
      if (chunk.length === 0) continue;
      const rows = this.db
        .prepare(
          `SELECT mc.monitor_id, c.uid FROM monitor_channels mc JOIN notify_channels c ON c.id = mc.channel_id
           WHERE c.deleted_at IS NULL AND mc.monitor_id IN (${chunk.map(() => '?').join(',')}) ORDER BY c.id`,
        )
        .all(...chunk) as Array<{ monitor_id: number; uid: string }>;
      for (const r of rows) {
        const list = out.get(r.monitor_id) ?? [];
        list.push(r.uid);
        out.set(r.monitor_id, list);
      }
    }
    return out;
  }

  /** Channels by uid (not deleted), with their owner, for link validation. */
  channelsByUid(uids: readonly string[]): Array<{ id: number; uid: string; ownerId: number | null }> {
    if (uids.length === 0) return [];
    const out: Array<{ id: number; uid: string; ownerId: number | null }> = [];
    for (const chunk of chunks(uids, 500)) {
      const rows = this.db
        .prepare(`SELECT id, uid, owner_id FROM notify_channels WHERE deleted_at IS NULL AND uid IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as Array<{ id: number; uid: string; owner_id: number | null }>;
      out.push(...rows.map((r) => ({ id: r.id, uid: r.uid, ownerId: r.owner_id })));
    }
    return out;
  }

  /** Default channels of an owner (linked to new monitors when the request names none). */
  defaultChannelIds(ownerId: number | null): number[] {
    const rows = this.db
      .prepare('SELECT id FROM notify_channels WHERE deleted_at IS NULL AND is_default = 1 AND owner_id IS ? ORDER BY id')
      .all(ownerId) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  setChannels(monitorId: number, channelIds: readonly number[]): void {
    this.db.prepare('DELETE FROM monitor_channels WHERE monitor_id = ?').run(monitorId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO monitor_channels (monitor_id, channel_id) VALUES (?, ?)');
    for (const c of channelIds) ins.run(monitorId, c);
  }

  /** Active, non-deleted channels linked to a monitor (outbox recipients). */
  activeChannelIds(monitorId: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM monitor_channels mc JOIN notify_channels c ON c.id = mc.channel_id
         WHERE mc.monitor_id = ? AND c.active = 1 AND c.deleted_at IS NULL ORDER BY c.id`,
      )
      .all(monitorId) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }
}

/** Remove a monitor's links to tags, channels, maintenances and status pages. */
export function unlinkMonitor(db: DB, id: number): void {
  db.prepare('DELETE FROM monitor_tags WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM monitor_channels WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM maintenance_monitors WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM status_page_monitors WHERE monitor_id = ?').run(id);
}

export function* chunks<T>(arr: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
