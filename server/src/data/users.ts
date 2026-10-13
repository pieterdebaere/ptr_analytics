import type { DB } from '../db/index.js';

export type Role = 'admin' | 'viewer' | 'member';
export const ROLES: readonly Role[] = ['admin', 'viewer', 'member'];

export type SubscriptionStatus = 'none' | 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'none',
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
];

/** Statuses in which the paid sites are granted (past_due: Stripe is still retrying the payment). */
export const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing', 'past_due']);

export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: number;
  emailVerified: boolean;
}

/** Billing state of a member (never sent to clients as is). */
export interface BillingState {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  paidSites: number;
  cancelAtPeriodEnd: boolean;
}

interface UserRow {
  id: number;
  email: string;
  role: Role;
  created_at: number;
  password_hash: string;
  email_verified_at: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  paid_sites: number;
  cancel_at_period_end: number;
}

export const toUser = (r: Pick<UserRow, 'id' | 'email' | 'role' | 'created_at' | 'email_verified_at'>): User => ({
  id: r.id,
  email: r.email,
  role: r.role,
  createdAt: r.created_at,
  emailVerified: r.email_verified_at !== null,
});

const toBilling = (r: UserRow): BillingState => ({
  stripeCustomerId: r.stripe_customer_id,
  stripeSubscriptionId: r.stripe_subscription_id,
  status: r.subscription_status,
  paidSites: r.paid_sites,
  cancelAtPeriodEnd: r.cancel_at_period_end === 1,
});

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

  byEmail(email: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  passwordHash(id: number): string | null {
    const r = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id) as { password_hash: string } | undefined;
    return r?.password_hash ?? null;
  }

  /**
   * Returns null if the email is already taken. Accounts are created verified unless
   * `verified` is false (self-service sign-up).
   */
  create(email: string, passwordHash: string, role: Role, now: number, verified = true): User | null {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO users (email, password_hash, role, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?)')
      .run(email.toLowerCase(), passwordHash, role, now, verified ? now : null);
    if (res.changes === 0) return null;
    return this.byId(Number(res.lastInsertRowid));
  }

  setRole(id: number, role: Role): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setPasswordHash(id: number, hash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  }

  markVerified(id: number, now: number): void {
    this.db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(now, id);
  }

  /**
   * Delete a user. Its sites are soft-deleted and detached first (in the same transaction),
   * so the `sites.owner_id ON DELETE CASCADE` never fires: a cascade into the sites would
   * delete all their analytics rows synchronously. The purge job removes the data later.
   * Login sessions and email tokens still cascade (a handful of rows).
   */
  delete(id: number, now: number): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare('UPDATE sites SET deleted_at = COALESCE(deleted_at, ?), owner_id = NULL, suspended = 0 WHERE owner_id = ?')
        .run(now, id);
      return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
    })();
  }

  /** Self-service sign-ups that have not verified their address yet. */
  countUnverified(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NULL AND role = 'member'`).get() as { n: number }
    ).n;
  }

  // ---- billing ----

  billing(id: number): BillingState | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? toBilling(r) : null;
  }

  /** The member a Stripe customer id belongs to (ids are only ever stored by us). */
  byStripeCustomer(customerId: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').get(customerId) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  /** Store the customer id unless one is already set; returns the id now stored. */
  setStripeCustomer(id: number, customerId: string): string | null {
    this.db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(customerId, id);
    return this.billing(id)?.stripeCustomerId ?? null;
  }

  setSubscription(
    id: number,
    s: { subscriptionId: string | null; status: SubscriptionStatus; paidSites: number; cancelAtPeriodEnd: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE users SET stripe_subscription_id = ?, subscription_status = ?, paid_sites = ?, cancel_at_period_end = ?
         WHERE id = ?`,
      )
      .run(s.subscriptionId, s.status, s.paidSites, s.cancelAtPeriodEnd ? 1 : 0, id);
  }

  /** Ids of all members (for recomputing suspensions). */
  memberIds(): number[] {
    return (this.db.prepare(`SELECT id FROM users WHERE role = 'member'`).all() as Array<{ id: number }>).map((r) => r.id);
  }

  /**
   * Delete self-service sign-ups that were never verified (no sites, no Stripe customer can
   * exist for them). Returns the number of deleted accounts.
   */
  purgeUnverified(olderThan: number): number {
    return this.db
      .prepare(
        `DELETE FROM users WHERE email_verified_at IS NULL AND role = 'member' AND created_at < ?
           AND stripe_customer_id IS NULL AND NOT EXISTS (SELECT 1 FROM sites WHERE sites.owner_id = users.id)`,
      )
      .run(olderThan).changes;
  }
}
