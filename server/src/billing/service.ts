import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import type { SiteRepo } from '../data/sites.js';
import { ENTITLED_STATUSES, type SubscriptionStatus, type User, type UserRepo } from '../data/users.js';
import { HttpError, badGateway, conflict } from '../lib/errors.js';
import { StripeError, idOf, type StripeClient, type StripeSubscription } from './stripe.js';

export const MAX_PAID_SITES = 1000;

export interface BillingSummary {
  enabled: boolean;
  freeSites: number;
  pricePerSiteCents: number;
  currency: string;
  sitesUsed: number;
  sitesAllowed: number;
  paidSites: number;
  status: SubscriptionStatus;
  hasCustomer: boolean;
  cancelAtPeriodEnd: boolean;
}

/** Statuses that block a new Checkout (the member must change the existing subscription). */
const LIVE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/** Stripe subscription status -> our status. */
export function mapStatus(s: string): SubscriptionStatus {
  switch (s) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
    case 'incomplete':
      return s;
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'unpaid';
    default:
      return 'incomplete';
  }
}

const RANK: Record<SubscriptionStatus, number> = {
  active: 0,
  trialing: 0,
  past_due: 0,
  unpaid: 1,
  incomplete: 2,
  canceled: 3,
  none: 4,
};

export const WEBHOOK_EVENTS: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

interface Deps {
  config: Config;
  db: DB;
  users: UserRepo;
  sites: SiteRepo;
  log: FastifyBaseLogger;
}

/**
 * Site allowance, suspensions and the Stripe subscription lifecycle (spec 6.4).
 *
 * Trust model: Stripe ids are only ever stored by us (customer created by us with the member's
 * id in its metadata). Webhooks are only a trigger: the state is always re-read from the Stripe
 * API for the customer id stored on the member, so a webhook can never grant more than the
 * member actually pays for, nor touch another account.
 */
export class BillingService {
  /** Per-member serialisation of Stripe syncs / mutations. */
  private readonly chains = new Map<number, Promise<void>>();
  private readonly busy = new Set<number>();

  constructor(
    private readonly d: Deps,
    readonly stripe: StripeClient | null,
  ) {}

  get enabled(): boolean {
    return this.d.config.cloud.billingEnabled && this.stripe !== null;
  }

  // ---- allowance & suspension ----

  /** Max number of active sites, or null for unlimited (admins, viewers). */
  allowance(user: Pick<User, 'id' | 'role'>): number | null {
    if (user.role !== 'member') return null;
    const cloud = this.d.config.cloud;
    if (!cloud.billingEnabled) return cloud.memberSiteLimit;
    const b = this.d.users.billing(user.id);
    const paid = b && ENTITLED_STATUSES.has(b.status) ? b.paidSites : 0;
    return cloud.freeSites + paid;
  }

  /** Recompute `sites.suspended` for one owner (call inside or outside a transaction). */
  recompute(userId: number): void {
    const user = this.d.users.byId(userId);
    if (!user) return;
    this.d.sites.applyAllowance(userId, this.allowance(user));
  }

  /** Recompute every member (startup: allowance settings may have changed). */
  recomputeAll(): void {
    this.d.db.transaction(() => {
      for (const id of this.d.users.memberIds()) this.recompute(id);
    })();
  }

  summary(user: User): BillingSummary {
    const cloud = this.d.config.cloud;
    const b = this.d.users.billing(user.id);
    return {
      enabled: this.enabled,
      freeSites: cloud.billingEnabled ? cloud.freeSites : cloud.memberSiteLimit,
      pricePerSiteCents: cloud.pricePerSiteCents,
      currency: cloud.priceCurrency,
      sitesUsed: this.d.sites.countByOwner(user.id),
      sitesAllowed: this.allowance(user) ?? 0,
      paidSites: b?.paidSites ?? 0,
      status: b?.status ?? 'none',
      hasCustomer: b?.stripeCustomerId != null,
      cancelAtPeriodEnd: b?.cancelAtPeriodEnd ?? false,
    };
  }

  // ---- serialisation ----

  /** Run fn after any running operation for this member (webhooks queue up). */
  private async serialized<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chain = prev.then(() => mine);
    this.chains.set(userId, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(userId) === chain) this.chains.delete(userId);
    }
  }

  /** User-initiated operations: one at a time per member (409 instead of queueing). */
  private async exclusive<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(userId)) throw conflict('another billing operation is in progress, try again');
    this.busy.add(userId);
    try {
      return await this.serialized(userId, fn);
    } finally {
      this.busy.delete(userId);
    }
  }

  /** Map Stripe failures to a generic 502 (logged without secrets). */
  private async callStripe<T>(what: string, fn: (stripe: StripeClient) => Promise<T>): Promise<T> {
    if (!this.stripe) throw new HttpError(404, 'not found');
    try {
      return await fn(this.stripe);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof StripeError) {
        this.d.log.error({ stripeStatus: err.status, stripeType: err.type, stripeCode: err.code }, `Stripe ${what} failed`);
      } else {
        this.d.log.error({ errName: err instanceof Error ? err.name : typeof err }, `Stripe ${what} failed`);
      }
      throw badGateway();
    }
  }

  // ---- sync ----

  /** Re-read the member's subscriptions from Stripe and store the result (caller serialises). */
  private async syncNow(userId: number, customerId: string): Promise<void> {
    const subs = await this.callStripe('subscription sync', (s) => s.listSubscriptions(customerId));
    this.applySubscriptions(userId, customerId, subs);
  }

  /** Store the subscription state derived from Stripe's data and recompute suspensions. */
  applySubscriptions(userId: number, customerId: string, subs: StripeSubscription[]): void {
    const priceId = this.d.config.cloud.stripePriceId;
    const relevant = subs
      .filter((s) => s.customer === customerId && s.items.some((i) => i.priceId === priceId))
      .map((s) => ({ sub: s, status: mapStatus(s.status) }))
      .sort((a, b) => RANK[a.status] - RANK[b.status] || b.sub.created - a.sub.created);
    const primary = relevant[0];
    const quantityOf = (s: StripeSubscription): number =>
      s.items.filter((i) => i.priceId === priceId).reduce((n, i) => n + Math.max(0, i.quantity), 0);
    const entitled = relevant.filter((r) => ENTITLED_STATUSES.has(r.status));
    if (entitled.length > 1) {
      this.d.log.warn({ userId, subscriptions: entitled.length }, 'member has more than one active subscription; resolve in Stripe');
    }
    const paidSites = Math.min(
      MAX_PAID_SITES,
      entitled.reduce((n, r) => n + quantityOf(r.sub), 0),
    );
    this.d.db.transaction(() => {
      this.d.users.setSubscription(userId, {
        subscriptionId: primary?.sub.id ?? null,
        status: primary?.status ?? 'none',
        paidSites,
        cancelAtPeriodEnd: primary?.sub.cancelAtPeriodEnd ?? false,
      });
      this.recompute(userId);
    })();
  }

  /** Handle a verified webhook event. Unknown types / customers are ignored. */
  async handleEvent(event: { type: string; object: Record<string, unknown> }): Promise<void> {
    if (!WEBHOOK_EVENTS.has(event.type)) return;
    const customerId = idOf(event.object['customer']);
    if (customerId === null) return;
    const user = this.d.users.byStripeCustomer(customerId);
    if (!user) return;
    if (event.type === 'checkout.session.completed') {
      const ref = event.object['client_reference_id'];
      if (ref != null && ref !== String(user.id)) {
        this.d.log.warn({ userId: user.id }, 'checkout session reference does not match the customer owner; ignored');
        return;
      }
    }
    await this.serialized(user.id, () => this.syncNow(user.id, customerId));
  }

  // ---- member actions ----

  async checkout(user: User, paidSites: number, urls: { success: string; cancel: string }): Promise<string> {
    return this.exclusive(user.id, async () => {
      let b = this.d.users.billing(user.id);
      if (!b) throw new HttpError(404, 'not found');
      // A missed webhook must not lead to a second subscription: refresh known customers first.
      if (b.stripeCustomerId !== null) {
        await this.syncNow(user.id, b.stripeCustomerId);
        b = this.d.users.billing(user.id);
        if (!b) throw new HttpError(404, 'not found');
      }
      if (LIVE_STATUSES.has(b.status)) throw conflict('you already have a subscription; change the number of paid sites instead');
      let customerId = b.stripeCustomerId;
      if (customerId === null) {
        const created = await this.callStripe('customer creation', (s) => s.createCustomer({ email: user.email, userId: user.id }));
        customerId = this.d.users.setStripeCustomer(user.id, created.id);
        if (customerId === null) throw new HttpError(404, 'not found');
      }
      const cid = customerId;
      const cloud = this.d.config.cloud;
      const { url } = await this.callStripe('checkout', (s) =>
        s.createCheckoutSession({
          customerId: cid,
          priceId: cloud.stripePriceId as string,
          quantity: paidSites,
          successUrl: urls.success,
          cancelUrl: urls.cancel,
          userId: user.id,
          automaticTax: cloud.stripeAutomaticTax,
        }),
      );
      return url;
    });
  }

  async setQuantity(user: User, paidSites: number): Promise<BillingSummary> {
    return this.exclusive(user.id, async () => {
      const b = this.d.users.billing(user.id);
      if (!b || b.stripeCustomerId === null || b.stripeSubscriptionId === null || !ENTITLED_STATUSES.has(b.status)) {
        throw conflict('no active subscription');
      }
      const customerId = b.stripeCustomerId;
      const subId = b.stripeSubscriptionId;
      const priceId = this.d.config.cloud.stripePriceId;
      const sub = await this.callStripe('subscription lookup', (s) => s.retrieveSubscription(subId));
      const item = sub.items.find((i) => i.priceId === priceId);
      if (sub.customer !== customerId || !item) {
        this.d.log.error({ userId: user.id }, 'stored subscription does not belong to the member or has no matching price');
        throw badGateway();
      }
      if (paidSites === 0) {
        if (!sub.cancelAtPeriodEnd) {
          await this.callStripe('subscription update', (s) => s.updateSubscription(sub.id, { cancelAtPeriodEnd: true }));
        }
      } else {
        if (sub.cancelAtPeriodEnd) {
          await this.callStripe('subscription update', (s) => s.updateSubscription(sub.id, { cancelAtPeriodEnd: false }));
        }
        if (item.quantity !== paidSites) {
          const increase = paidSites > item.quantity;
          await this.callStripe('subscription update', (s) =>
            s.updateSubscription(
              sub.id,
              increase
                ? // charge the prorated amount now; the change only applies once it is paid
                  { item: { id: item.id, quantity: paidSites }, prorationBehavior: 'always_invoice', paymentBehavior: 'pending_if_incomplete' }
                : { item: { id: item.id, quantity: paidSites }, prorationBehavior: 'create_prorations' },
            ),
          );
        }
      }
      await this.syncNow(user.id, customerId);
      return this.summary(user);
    });
  }

  async portal(user: User, returnUrl: string): Promise<string> {
    return this.exclusive(user.id, async () => {
      const b = this.d.users.billing(user.id);
      const customerId = b?.stripeCustomerId ?? null;
      if (customerId === null) throw conflict('no billing account yet');
      const { url } = await this.callStripe('portal', (s) => s.createPortalSession({ customerId, returnUrl }));
      return url;
    });
  }

  /**
   * Account deletion: cancel every live subscription immediately, then delete the Stripe
   * customer (so a still-open Checkout session cannot start a new subscription). Throws
   * (502) when Stripe cannot be reached, so the account is not deleted while still billed.
   */
  async cancelAll(userId: number): Promise<void> {
    const b = this.d.users.billing(userId);
    if (!b || b.stripeCustomerId === null) return;
    const customerId = b.stripeCustomerId;
    if (!this.stripe) {
      if (b.status !== 'none' && b.status !== 'canceled') {
        throw conflict('the subscription cannot be cancelled automatically; contact the operator');
      }
      return;
    }
    await this.exclusive(userId, async () => {
      const subs = await this.callStripe('subscription lookup', (s) => s.listSubscriptions(customerId));
      for (const sub of subs) {
        if (sub.customer !== customerId) continue;
        if (sub.status === 'canceled' || sub.status === 'incomplete_expired') continue;
        await this.callStripe('subscription cancel', (s) => s.cancelSubscription(sub.id));
      }
      await this.callStripe('customer deletion', (s) => s.deleteCustomer(customerId));
    });
  }
}
