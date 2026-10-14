import { describe, expect, it } from 'vitest';
import {
  billingStatusTone,
  clampPaidSites,
  formatPrice,
  hasSubscription,
  monthlyCostCents,
  paidSitesNeeded,
  pricingNote,
  safeStripeUrl,
  suggestedPaidSites,
  usageRatio,
} from '../lib/billing';

describe('pricing', () => {
  it('formats prices in minor units', () => {
    expect(formatPrice(100, 'eur', 'en')).toBe('€1');
    expect(formatPrice(150, 'usd', 'en')).toBe('$1.50');
    expect(formatPrice(1234, 'EUR', 'en')).toBe('€12.34');
    expect(formatPrice(100, 'not a currency', 'en')).toBe('€1');
  });

  it('computes the monthly cost', () => {
    expect(monthlyCostCents(0, 100)).toBe(0);
    expect(monthlyCostCents(3, 100)).toBe(300);
    expect(monthlyCostCents(2.7, 100)).toBe(200);
    expect(monthlyCostCents(-5, 100)).toBe(0);
    expect(monthlyCostCents(5000, 100)).toBe(100_000);
    expect(monthlyCostCents(3, Number.NaN)).toBe(0);
  });

  it('clamps quantities', () => {
    expect(clampPaidSites(Number.NaN)).toBe(0);
    expect(clampPaidSites(Number.NaN, 1)).toBe(1);
    expect(clampPaidSites(0, 1)).toBe(1);
    expect(clampPaidSites(12.9)).toBe(12);
    expect(clampPaidSites(1e9)).toBe(1000);
  });

  it('derives paid sites from the allowance', () => {
    expect(paidSitesNeeded(3, 1)).toBe(2);
    expect(paidSitesNeeded(1, 1)).toBe(0);
    expect(paidSitesNeeded(0, 3)).toBe(0);
    // room for one more site
    expect(suggestedPaidSites({ sitesUsed: 1, sitesAllowed: 1, freeSites: 1, paidSites: 0 })).toBe(1);
    expect(suggestedPaidSites({ sitesUsed: 0, sitesAllowed: 1, freeSites: 1, paidSites: 0 })).toBe(1);
    // re-activate suspended sites
    expect(suggestedPaidSites({ sitesUsed: 4, sitesAllowed: 1, freeSites: 1, paidSites: 0 })).toBe(3);
  });

  it('writes the pricing note', () => {
    expect(pricingNote({ freeSites: 1, pricePerSiteCents: 100, currency: 'eur' }, 'en')).toBe('First site free, then €1/month per site');
    expect(pricingNote({ freeSites: 3, pricePerSiteCents: 250, currency: 'usd' }, 'en')).toBe('First 3 sites free, then $2.50/month per site');
    expect(pricingNote({ freeSites: 0, pricePerSiteCents: 100, currency: 'eur' }, 'en')).toBe('€1/month per site');
  });

  it('classifies subscription states', () => {
    expect(hasSubscription('active')).toBe(true);
    expect(hasSubscription('past_due')).toBe(true);
    expect(hasSubscription('none')).toBe(false);
    expect(hasSubscription('canceled')).toBe(false);
    expect(billingStatusTone('active')).toBe('good');
    expect(billingStatusTone('unpaid')).toBe('poor');
    expect(usageRatio({ sitesUsed: 2, sitesAllowed: 4 })).toBe(0.5);
    expect(usageRatio({ sitesUsed: 5, sitesAllowed: 4 })).toBe(1);
    expect(usageRatio({ sitesUsed: 0, sitesAllowed: 0 })).toBe(1);
  });
});

describe('safeStripeUrl', () => {
  it('accepts Stripe checkout and portal URLs', () => {
    expect(safeStripeUrl('https://checkout.stripe.com/c/pay/cs_test_123#fid', 'checkout')).toBe(
      'https://checkout.stripe.com/c/pay/cs_test_123#fid',
    );
    expect(safeStripeUrl('https://billing.stripe.com/p/session/test_abc', 'portal')).toBe('https://billing.stripe.com/p/session/test_abc');
  });

  it('rejects everything else', () => {
    const bad = [
      'https://checkout.stripe.com.evil.example/pay',
      'https://evil.example/https://checkout.stripe.com/',
      'http://checkout.stripe.com/pay',
      'javascript:alert(1)',
      '//checkout.stripe.com/pay',
      '/billing',
      'https://user:pw@checkout.stripe.com/pay',
      'https://checkout.stripe.com:8443/pay',
      'https://evilcheckout.stripe.com/pay',
      ' https://checkout.stripe.com/pay',
      'https://checkout.stripe.com\\@evil.example/',
      'data:text/html,<script>alert(1)</script>',
      '',
    ];
    for (const u of bad) expect(safeStripeUrl(u, 'checkout'), u).toBeNull();
    expect(safeStripeUrl(42, 'checkout')).toBeNull();
    expect(safeStripeUrl(null, 'portal')).toBeNull();
    expect(safeStripeUrl('x'.repeat(5000), 'portal')).toBeNull();
    // the right origin for the right purpose only
    expect(safeStripeUrl('https://billing.stripe.com/p/session/x', 'checkout')).toBeNull();
    expect(safeStripeUrl('https://checkout.stripe.com/c/pay/x', 'portal')).toBeNull();
  });
});
