import type { DB } from '../db/index.js';
import { generateSiteId } from '../lib/ids.js';

export interface Site {
  id: string;
  name: string;
  domains: string[];
  createdAt: number;
}

interface SiteRow {
  id: string;
  name: string;
  domains: string;
  created_at: number;
}

function parseDomains(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

const toSite = (r: SiteRow): Site => ({ id: r.id, name: r.name, domains: parseDomains(r.domains), createdAt: r.created_at });

export class SiteRepo {
  constructor(private readonly db: DB) {}

  list(): Site[] {
    return (this.db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE, id').all() as SiteRow[]).map(toSite);
  }

  byId(id: string): Site | null {
    const r = this.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as SiteRow | undefined;
    return r ? toSite(r) : null;
  }

  ids(): string[] {
    return (this.db.prepare('SELECT id FROM sites').all() as Array<{ id: string }>).map((r) => r.id);
  }

  create(name: string, domains: string[], now: number): Site {
    const insert = this.db.prepare('INSERT OR IGNORE INTO sites (id, name, domains, created_at) VALUES (?, ?, ?, ?)');
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = generateSiteId();
      if (insert.run(id, name, JSON.stringify(domains), now).changes === 1) {
        return { id, name, domains, createdAt: now };
      }
    }
    throw new Error('could not allocate a unique site id');
  }

  update(id: string, patch: { name?: string; domains?: string[] }): Site | null {
    const site = this.byId(id);
    if (!site) return null;
    const name = patch.name ?? site.name;
    const domains = patch.domains ?? site.domains;
    this.db.prepare('UPDATE sites SET name = ?, domains = ? WHERE id = ?').run(name, JSON.stringify(domains), id);
    return { ...site, name, domains };
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sites WHERE id = ?').run(id).changes > 0;
  }
}
