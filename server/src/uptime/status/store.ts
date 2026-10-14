// Persistence of status pages, sections, custom domains, incidents and uploaded assets
// (schema: uptime/schema/status.ts). Monitor tables are only read.
import { randomBytes, randomInt } from 'node:crypto';
import type { DB } from '../../db/index.js';
import type { IncidentStyle, Theme } from './validate.js';

export interface PageRow {
  id: number;
  uid: string;
  site_id: string;
  slug: string;
  title: string;
  description: string | null;
  footer: string | null;
  logo_asset: string | null;
  theme: Theme;
  accent: string | null;
  published: number;
  noindex: number;
  show_tags: number;
  show_cert_expiry: number;
  show_powered_by: number;
  refresh_s: number;
  tz: string;
  analytics_site_id: string | null;
  created_at: number;
  updated_at: number;
}

const PAGE_SELECT = `SELECT p.* FROM status_pages p JOIN sites s ON s.id = p.site_id AND s.deleted_at IS NULL
  WHERE p.deleted_at IS NULL`;

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function randomUid(n = 12): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}

export const UID_RE = /^[a-z0-9]{12}$/;

export function pageByUid(db: DB, uid: string): PageRow | null {
  if (!UID_RE.test(uid)) return null;
  return (db.prepare(`${PAGE_SELECT} AND p.uid = ?`).get(uid) as PageRow | undefined) ?? null;
}

export function pageById(db: DB, id: number): PageRow | null {
  return (db.prepare(`${PAGE_SELECT} AND p.id = ?`).get(id) as PageRow | undefined) ?? null;
}

export function pageBySlug(db: DB, slug: string): PageRow | null {
  return (db.prepare(`${PAGE_SELECT} AND p.slug = ?`).get(slug) as PageRow | undefined) ?? null;
}

export function pagesForSites(db: DB, siteIds: readonly string[]): PageRow[] {
  if (siteIds.length === 0) return [];
  return db
    .prepare(`${PAGE_SELECT} AND p.site_id IN (SELECT value FROM json_each(?)) ORDER BY p.title COLLATE NOCASE, p.id`)
    .all(JSON.stringify(siteIds)) as PageRow[];
}

export function countPagesForSite(db: DB, siteId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM status_pages WHERE site_id = ? AND deleted_at IS NULL').get(siteId) as { n: number }).n;
}

export function slugTaken(db: DB, slug: string, exceptId?: number): boolean {
  return db.prepare('SELECT 1 FROM status_pages WHERE slug = ? AND id <> ?').get(slug, exceptId ?? -1) !== undefined;
}

/* ------------------------------------------------------------------ sections */

export interface SectionMonitor {
  monitorId: number;
  uid: string;
  name: string;
  displayName: string | null;
  showUrl: boolean;
}

export interface Section {
  name: string;
  monitors: SectionMonitor[];
}

export function sectionsOf(db: DB, pageId: number): Section[] {
  const secs = db
    .prepare('SELECT id, name FROM status_page_sections WHERE status_page_id = ? ORDER BY position, id')
    .all(pageId) as Array<{ id: number; name: string }>;
  const rows = db
    .prepare(
      `SELECT spm.section_id, spm.monitor_id, m.uid, m.name, spm.display_name, spm.show_url
       FROM status_page_monitors spm
       JOIN status_page_sections sec ON sec.id = spm.section_id
       JOIN status_pages p ON p.id = sec.status_page_id
       -- same site only: a purged monitor's integer id may be reused by another tenant's monitor
       JOIN monitors m ON m.id = spm.monitor_id AND m.deleted_at IS NULL AND m.site_id = p.site_id
       WHERE sec.status_page_id = ? ORDER BY spm.position, m.id`,
    )
    .all(pageId) as Array<{ section_id: number; monitor_id: number; uid: string; name: string; display_name: string | null; show_url: number }>;
  const bySection = new Map<number, SectionMonitor[]>();
  for (const r of rows) {
    const list = bySection.get(r.section_id) ?? [];
    list.push({ monitorId: r.monitor_id, uid: r.uid, name: r.name, displayName: r.display_name, showUrl: r.show_url === 1 });
    bySection.set(r.section_id, list);
  }
  return secs.map((s) => ({ name: s.name, monitors: bySection.get(s.id) ?? [] }));
}

export interface SectionInput {
  name: string;
  monitors: Array<{ monitorId: number; displayName: string | null; showUrl: boolean }>;
}

export function replaceSections(db: DB, pageId: number, sections: SectionInput[]): void {
  db.prepare('DELETE FROM status_page_sections WHERE status_page_id = ?').run(pageId);
  const insSec = db.prepare('INSERT INTO status_page_sections (status_page_id, name, position) VALUES (?, ?, ?)');
  const insMon = db.prepare(
    'INSERT INTO status_page_monitors (section_id, monitor_id, position, display_name, show_url) VALUES (?, ?, ?, ?, ?)',
  );
  sections.forEach((s, i) => {
    const secId = Number(insSec.run(pageId, s.name, i).lastInsertRowid);
    s.monitors.forEach((m, j) => insMon.run(secId, m.monitorId, j, m.displayName, m.showUrl ? 1 : 0));
  });
}

/* ------------------------------------------------------------------- domains */

/** Unverified claims are dropped after this time (the owner can add the domain again). */
export const DOMAIN_CLAIM_TTL_MS = 7 * 86_400_000;

export interface DomainRow {
  domain: string;
  status_page_id: number;
  verify_token: string;
  created_at: number;
  verified_at: number | null;
}

export function domainsOf(db: DB, pageId: number): DomainRow[] {
  return db.prepare('SELECT * FROM status_page_domains WHERE status_page_id = ? ORDER BY domain').all(pageId) as DomainRow[];
}

/** This page's claim of a domain (pending or verified), or null. Other pages' claims are never looked at. */
export function domainClaim(db: DB, domain: string, pageId: number): DomainRow | null {
  return (
    (db.prepare('SELECT * FROM status_page_domains WHERE domain = ? AND status_page_id = ?').get(domain, pageId) as DomainRow | undefined) ?? null
  );
}

/** Drop unverified claims older than DOMAIN_CLAIM_TTL_MS. Returns how many. */
export function expireDomainClaims(db: DB, now: number): number {
  return db.prepare('DELETE FROM status_page_domains WHERE verified_at IS NULL AND created_at <= ?').run(now - DOMAIN_CLAIM_TTL_MS).changes;
}

/**
 * Replace the page's domain list, keeping token and verification of domains that stay. New
 * domains are pending claims; other pages may claim the same domain (nobody can block a
 * domain they do not control, and the answer never tells whether someone else claimed it).
 */
export function replaceDomains(db: DB, pageId: number, domains: string[], now: number): void {
  const existing = new Map(domainsOf(db, pageId).map((d) => [d.domain, d]));
  for (const d of existing.keys()) {
    if (!domains.includes(d)) db.prepare('DELETE FROM status_page_domains WHERE domain = ? AND status_page_id = ?').run(d, pageId);
  }
  const ins = db.prepare(
    'INSERT INTO status_page_domains (domain, status_page_id, verify_token, created_at, verified_at) VALUES (?, ?, ?, ?, NULL)',
  );
  for (const d of domains) {
    if (!existing.has(d)) ins.run(d, pageId, `ptr-status-verify=${randomBytes(18).toString('base64url')}`, now);
  }
}

/** The verified claim of a domain (any page), or null. */
export function verifiedClaim(db: DB, domain: string): DomainRow | null {
  return (db.prepare('SELECT * FROM status_page_domains WHERE domain = ? AND verified_at IS NOT NULL').get(domain) as DomainRow | undefined) ?? null;
}

/**
 * The page proved control of the domain (fresh DNS TXT check; the caller made sure no other
 * page still holds a verification whose token is published): its claim becomes the one
 * verified row and every other claim of the domain (other pages' pending claims, or the
 * stale verification of a previous DNS owner) is removed. Atomic.
 */
export function markDomainVerified(db: DB, domain: string, pageId: number, now: number): boolean {
  return db.transaction(() => {
    const own = domainClaim(db, domain, pageId);
    if (!own) return false;
    db.prepare('DELETE FROM status_page_domains WHERE domain = ? AND status_page_id <> ?').run(domain, pageId);
    db.prepare('UPDATE status_page_domains SET verified_at = ? WHERE domain = ? AND status_page_id = ?').run(own.verified_at ?? now, domain, pageId);
    return true;
  })();
}

/* ----------------------------------------------------------------- incidents */

export interface IncidentRow {
  id: number;
  uid: string;
  status_page_id: number;
  title: string;
  body: string;
  style: IncidentStyle;
  pinned: number;
  created_at: number;
  updated_at: number | null;
  resolved_at: number | null;
}

export interface IncidentJson {
  uid: string;
  title: string;
  body: string;
  style: IncidentStyle;
  pinned: boolean;
  createdAt: number;
  updatedAt: number | null;
  resolvedAt: number | null;
}

export const incidentJson = (r: IncidentRow): IncidentJson => ({
  uid: r.uid,
  title: r.title,
  body: r.body,
  style: r.style,
  pinned: r.pinned === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  resolvedAt: r.resolved_at,
});

export function incidentsOf(db: DB, pageId: number, limit: number): IncidentRow[] {
  return db
    .prepare('SELECT * FROM incidents WHERE status_page_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(pageId, limit) as IncidentRow[];
}

/** Public selection: pinned or unresolved incidents, plus the last 10 resolved ones. */
export function publicIncidents(db: DB, pageId: number): IncidentRow[] {
  const open = db
    .prepare('SELECT * FROM incidents WHERE status_page_id = ? AND (pinned = 1 OR resolved_at IS NULL) ORDER BY created_at DESC, id DESC LIMIT 20')
    .all(pageId) as IncidentRow[];
  const resolved = db
    .prepare(
      `SELECT * FROM incidents WHERE status_page_id = ? AND pinned = 0 AND resolved_at IS NOT NULL
       ORDER BY resolved_at DESC, id DESC LIMIT 10`,
    )
    .all(pageId) as IncidentRow[];
  return [...open, ...resolved];
}

export function incidentByUid(db: DB, uid: string): IncidentRow | null {
  if (!UID_RE.test(uid)) return null;
  return (db.prepare('SELECT * FROM incidents WHERE uid = ?').get(uid) as IncidentRow | undefined) ?? null;
}

export function countIncidents(db: DB, pageId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE status_page_id = ?').get(pageId) as { n: number }).n;
}

/* -------------------------------------------------------------------- assets */

export function putAsset(db: DB, sha256: string, ownerId: number | null, mime: string, bytes: Buffer, now: number): void {
  db.prepare('INSERT OR IGNORE INTO assets (sha256, owner_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)').run(sha256, ownerId, mime, bytes, now);
}

export function getAsset(db: DB, sha256: string): { mime: string; bytes: Buffer } | null {
  return (db.prepare('SELECT mime, bytes FROM assets WHERE sha256 = ?').get(sha256) as { mime: string; bytes: Buffer } | undefined) ?? null;
}

/** Delete an asset nothing refers to any more. */
export function gcAsset(db: DB, sha256: string | null): void {
  if (!sha256) return;
  db.prepare('DELETE FROM assets WHERE sha256 = ? AND NOT EXISTS (SELECT 1 FROM status_pages WHERE logo_asset = ?)').run(sha256, sha256);
}

/** Is the asset the logo of at least one published page of a live site? (public serving) */
export function assetPublished(db: DB, sha256: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM status_pages p JOIN sites s ON s.id = p.site_id AND s.deleted_at IS NULL
         WHERE p.logo_asset = ? AND p.published = 1 AND p.deleted_at IS NULL LIMIT 1`,
      )
      .get(sha256) !== undefined
  );
}

/**
 * What the public JSON of a slug depends on beyond its own updates (which invalidate the
 * cache): which page holds the slug, whether it is published, its site's state. null = not
 * served.
 */
export function pageFingerprint(db: DB, slug: string): string | null {
  const r = db
    .prepare(
      `SELECT p.id, p.updated_at, s.suspended FROM status_pages p JOIN sites s ON s.id = p.site_id AND s.deleted_at IS NULL
       WHERE p.slug = ? AND p.deleted_at IS NULL AND p.published = 1`,
    )
    .get(slug) as { id: number; updated_at: number; suspended: number } | undefined;
  return r ? `${r.id}:${r.updated_at}:${r.suspended}` : null;
}

export const assetUrl = (sha256: string | null): string | null => (sha256 ? `/api/public/assets/${sha256}` : null);
