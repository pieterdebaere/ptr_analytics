import type { DB } from '../db/index.js';

export type Role = 'admin' | 'viewer';
export const ROLES: readonly Role[] = ['admin', 'viewer'];

export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: number;
}

interface UserRow {
  id: number;
  email: string;
  role: Role;
  created_at: number;
  password_hash: string;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at });

export class UserRepo {
  constructor(private readonly db: DB) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  countAdmins(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }).n;
  }

  list(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]).map(toUser);
  }

  byId(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  /** Returns the user plus its password hash (for login). */
  byEmailWithHash(email: string): { user: User; passwordHash: string } | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return r ? { user: toUser(r), passwordHash: r.password_hash } : null;
  }

  passwordHash(id: number): string | null {
    const r = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
    return r?.password_hash ?? null;
  }

  /** Returns null if the email is already taken. */
  create(email: string, passwordHash: string, role: Role, now: number): User | null {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(email.toLowerCase(), passwordHash, role, now);
    if (res.changes === 0) return null;
    return this.byId(Number(res.lastInsertRowid));
  }

  setRole(id: number, role: Role): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setPasswordHash(id: number, hash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }
}
