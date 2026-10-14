import { describe, expect, it } from 'vitest';
import {
  clampSites,
  formatPrice,
  monthlyPriceCents,
  paidSites,
  yearlyPriceCents,
  type PricingModel,
} from './pricing';

const model: PricingModel = { freeSites: 1, pricePerSiteCents: 100 };

describe('monthlyPriceCents', () => {
  it('is free for the first website', () => {
    expect(monthlyPriceCents(0, model)).toBe(0);
    expect(monthlyPriceCents(1, model)).toBe(0);
  });

  it('charges €1 per additional website: max(0, n − 1) × €1', () => {
    expect(monthlyPriceCents(2, model)).toBe(100);
    expect(monthlyPriceCents(5, model)).toBe(400);
    expect(monthlyPriceCents(50, model)).toBe(4900);
  });

  it('never goes negative and ignores fractional / invalid input', () => {
    expect(monthlyPriceCents(-3, model)).toBe(0);
    expect(monthlyPriceCents(Number.NaN, model)).toBe(0);
    expect(monthlyPriceCents(3.9, model)).toBe(200);
  });

  it('respects a different free allowance and price', () => {
    const custom: PricingModel = { freeSites: 3, pricePerSiteCents: 250 };
    expect(paidSites(2, custom)).toBe(0);
    expect(monthlyPriceCents(5, custom)).toBe(500);
    expect(yearlyPriceCents(5, custom)).toBe(6000);
  });
});

describe('clampSites', () => {
  it('keeps the count between 1 and 1000 and rounds', () => {
    expect(clampSites(0)).toBe(1);
    expect(clampSites(-10)).toBe(1);
    expect(clampSites(Number.NaN)).toBe(1);
    expect(clampSites(4.6)).toBe(5);
    expect(clampSites(5000)).toBe(1000);
  });
});

describe('formatPrice', () => {
  it('formats euros without needless decimals', () => {
    expect(formatPrice(0)).toBe('€0');
    expect(formatPrice(100)).toBe('€1');
    expect(formatPrice(4900)).toBe('€49');
    expect(formatPrice(1250)).toBe('€12.50');
  });
});
