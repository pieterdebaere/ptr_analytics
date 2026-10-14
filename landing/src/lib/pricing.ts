/** Hosted-plan price calculation: the first `freeSites` websites are free, every
 *  additional website costs `pricePerSiteCents` per month. */

export interface PricingModel {
  freeSites: number;
  pricePerSiteCents: number;
}

export const MIN_SITES = 1;
export const MAX_SITES = 1000;

/** Clamp any user input (NaN, decimals, negatives, huge numbers) to a valid website count. */
export function clampSites(value: number, min = MIN_SITES, max = MAX_SITES): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Number of websites that are billed: max(0, n − freeSites). */
export function paidSites(sites: number, model: PricingModel): number {
  const n = Number.isFinite(sites) ? Math.max(0, Math.floor(sites)) : 0;
  return Math.max(0, n - Math.max(0, model.freeSites));
}

/** Monthly price in cents: max(0, n − freeSites) × pricePerSiteCents. */
export function monthlyPriceCents(sites: number, model: PricingModel): number {
  return paidSites(sites, model) * model.pricePerSiteCents;
}

/** Yearly price in cents (12 × monthly; no discounts). */
export function yearlyPriceCents(sites: number, model: PricingModel): number {
  return monthlyPriceCents(sites, model) * 12;
}

/** Format cents as a price, e.g. `€0`, `€1`, `€12.50`. Whole amounts drop the decimals. */
export function formatPrice(cents: number, currency = 'EUR', locale = 'en-IE'): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
