// Tags belong to a user (`owner_id`; NULL = operator tag, visible to admins and viewers).
import type { DB } from '../../db/index.js';
import { generateSiteId } from '../../lib/ids.js';
import { chunks } from './monitors.js';

export const TAG_UID_RE = /^[a-z0-9]{12}$/;

export interface TagRecord {
  id: number;
  uid: string;
  ownerId: number | null;
  name: string;
  color: string;
}

interface TagRow {
  id: number;
  uid: string;
  owner_id: number | null;
  name: string;
  color: string;
}

const toTag = (r: TagRow): TagRecord => ({ id: r.id, uid: r.uid, ownerId: r.owner_id, name: r.name, color: r.color });

export class TagRepo {
  constructor(private readonly db: DB) {}

  /** null = every tag (admins / viewers). */
  list(ownerId: number | null | 'all'): TagRecord[] {
    const rows =
      ownerId === 'all'
        ? (this.db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE, id').all() as TagRow[])
        : (this.db.prepare('SELECT * FROM tags WHERE owner_id IS ? ORDER BY name COLLATE NOCASE, id').all(ownerId) as TagRow[]);
    return rows.map(toTag);
  }

  byUid(uid: string): TagRecord | null {
    if (!TAG_UID_RE.test(uid)) return null;
    const r = this.db.prepare('SELECT * FROM tags WHERE uid = ?').get(uid) as TagRow | undefined;
    return r ? toTag(r) : null;
  }

  byUids(uids: readonly string[]): TagRecord[] {
    const valid = uids.filter((u) => TAG_UID_RE.test(u));
    const out: TagRecord[] = [];
    for (const chunk of chunks(valid, 500)) {
      if (chunk.length === 0) continue;
      out.push(...(this.db.prepare(`SELECT * FROM tags WHERE uid IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as TagRow[]).map(toTag));
    }
    return out;
  }

  nameTaken(ownerId: number | null, name: string, exceptId?: number): boolean {
    const r = this.db
      .prepare('SELECT id FROM tags WHERE owner_id IS ? AND name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(ownerId, name, exceptId ?? null) as { id: number } | undefined;
    return r !== undefined;
  }

  countByOwner(ownerId: number | null): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM tags WHERE owner_id IS ?').get(ownerId) as { n: number }).n;
  }

  create(ownerId: number | null, name: string, color: string): TagRecord {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO tags (uid, owner_id, name, color) VALUES (?, ?, ?, ?)');
    for (let attempt = 0; attempt < 10; attempt++) {
      const uid = generateSiteId();
      const res = stmt.run(uid, ownerId, name, color);
      if (res.changes === 1) return { id: Number(res.lastInsertRowid), uid, ownerId, name, color };
    }
    throw new Error('could not allocate a unique tag uid');
  }

  update(id: number, patch: { name?: string; color?: string }): void {
    if (patch.name !== undefined) this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.color !== undefined) this.db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(patch.color, id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  }
}
