// Pricing and billing helpers (hosted mode, docs/SPEC.md 6.4).
import type { Billing, BillingStatus, PublicConfig } from '../api/types';

export const MAX_PAID_SITES = 1000;

const CURRENCY_RE = /^[a-z]{3}$/i;

/** Formats an amount in minor units, e.g. (100, "eur") -> "€1", (150, "usd") -> "$1.50". */
export function formatPrice(cents: number, currency: string, locale?: string): string {
  if (!Number.isFinite(cents)) return '–';
  const code = CURRENCY_RE.test(currency) ? currency.toUpperCase() : 'EUR';
  const value = cents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

/** Clamps a requested number of paid sites to 0..MAX_PAID_SITES (integers only). */
export function clampPaidSites(n: number, min = 0): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(MAX_PAID_SITES, Math.max(min, Math.floor(n)));
}

/** Monthly cost in minor units for `paidSites` paid sites. */
export function monthlyCostCents(paidSites: number, pricePerSiteCents: number): number {
  const n = clampPaidSites(paidSites);
  const price = Number.isFinite(pricePerSiteCents) && pricePerSiteCents > 0 ? pricePerSiteCents : 0;
  return n * price;
}

/**
 * Paid sites needed to host `sites` sites when `freeSites` are included
 * (never negative, e.g. 3 sites with 1 free -> 2 paid).
 */
export function paidSitesNeeded(sites: number, freeSites: number): number {
  return clampPaidSites(Math.max(0, Math.floor(sites) - Math.max(0, Math.floor(freeSites))));
}

/**
 * Default quantity for the "add paid sites" form: enough paid sites to
 * re-activate suspended sites, otherwise room for one more site (at least 1).
 */
export function suggestedPaidSites(b: Pick<Billing, 'sitesUsed' | 'sitesAllowed' | 'freeSites' | 'paidSites'>): number {
  const target = b.sitesUsed > b.sitesAllowed ? b.sitesUsed : Math.max(b.sitesUsed, b.sitesAllowed) + 1;
  return clampPaidSites(Math.max(1, paidSitesNeeded(target, b.freeSites)), 1);
}

/** "First site free, then €1/month per site" (or variants) from the public config. */
export function pricingNote(cfg: Pick<PublicConfig, 'freeSites' | 'pricePerSiteCents' | 'currency'>, locale?: string): string {
  const price = `${formatPrice(cfg.pricePerSiteCents, cfg.currency, locale)}/month per site`;
  const free = Math.max(0, Math.floor(cfg.freeSites));
  if (free === 0) return `${price.charAt(0).toUpperCase()}${price.slice(1)}`;
  const freePart = free === 1 ? 'First site free' : `First ${free} sites free`;
  return `${freePart}, then ${price}`;
}

/** A subscription exists (quantity changes go through /billing/quantity, not checkout). */
export function hasSubscription(status: BillingStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid';
}

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  none: 'Free plan',
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  unpaid: 'Unpaid',
  incomplete: 'Incomplete',
};

export type StatusTone = 'good' | 'warn' | 'poor' | 'neutral';

export function billingStatusTone(status: BillingStatus): StatusTone {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'good';
    case 'past_due':
    case 'incomplete':
      return 'warn';
    case 'unpaid':
      return 'poor';
    default:
      return 'neutral';
  }
}

/** Share of the allowance in use, 0..1 (1 when nothing is allowed). */
export function usageRatio(b: Pick<Billing, 'sitesUsed' | 'sitesAllowed'>): number {
  if (!(b.sitesAllowed > 0)) return 1;
  return Math.min(1, Math.max(0, b.sitesUsed / b.sitesAllowed));
}

const STRIPE_ORIGINS = {
  checkout: 'https://checkout.stripe.com',
  portal: 'https://billing.stripe.com',
} as const;

export type StripeUrlKind = keyof typeof STRIPE_ORIGINS;

/**
 * Validates a redirect URL returned by the server before `window.location.assign`:
 * only `https://checkout.stripe.com/…` (checkout) or `https://billing.stripe.com/…`
 * (customer portal), without credentials or a custom port. Returns the normalised
 * href, or null when the URL is not acceptable.
 */
export function safeStripeUrl(raw: unknown, kind: StripeUrlKind): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (url.origin !== STRIPE_ORIGINS[kind]) return null;
  return url.href;
}
