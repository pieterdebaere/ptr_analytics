// Fake but plausible live traffic for demos (landing page hero, previews).

import { useEffect, useRef, useState } from 'react';
import type { GlobeCountryValue, GlobePing } from './globe';

/** Rough share of web traffic per country (relative weights). */
export const DEMO_COUNTRY_WEIGHTS: Readonly<Record<string, number>> = {
  US: 26, IN: 9, DE: 7.5, GB: 7, BR: 6, FR: 5, JP: 4.5, CA: 4, NL: 3.5, BE: 3,
  ES: 3, IT: 3, AU: 2.8, PL: 2.2, MX: 2.2, ID: 2, KR: 1.8, TR: 1.6, SE: 1.6, CH: 1.5,
  PH: 1.4, VN: 1.3, AR: 1.2, SG: 1.2, AT: 1.1, DK: 1, NO: 1, IE: 1, PT: 1, ZA: 0.9,
  NG: 0.9, CO: 0.9, UA: 0.9, FI: 0.8, CZ: 0.8, IL: 0.8, TH: 0.8, EG: 0.7, RO: 0.7, CL: 0.7,
  NZ: 0.6, MY: 0.6, GR: 0.5, HU: 0.5, KE: 0.45, PK: 0.45, BD: 0.4, SA: 0.4, AE: 0.4, PE: 0.35,
  MA: 0.3, TW: 0.5, HK: 0.4, LU: 0.2, IS: 0.12,
};

/** Small deterministic PRNG (mulberry32) so the initial state is stable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIGHT_ENTRIES = Object.entries(DEMO_COUNTRY_WEIGHTS);
const WEIGHT_TOTAL = WEIGHT_ENTRIES.reduce((s, [, w]) => s + w, 0);

/** Picks a country proportionally to its weight for r in [0, 1). */
export function pickWeightedCountry(r: number): string {
  let x = Math.max(0, Math.min(0.999999, r)) * WEIGHT_TOTAL;
  for (const [code, w] of WEIGHT_ENTRIES) {
    x -= w;
    if (x < 0) return code;
  }
  return WEIGHT_ENTRIES[WEIGHT_ENTRIES.length - 1]?.[0] ?? 'US';
}

/** Initial per-country totals: weight × scale with ±25 % noise. */
export function initialDemoCountries(scale = 48, seed = 7): GlobeCountryValue[] {
  const rnd = mulberry32(seed);
  return WEIGHT_ENTRIES.map(([country, w]) => ({
    country,
    value: Math.max(1, Math.round(w * scale * (0.75 + rnd() * 0.5))),
  })).sort((a, b) => b.value - a.value);
}

export interface DemoTrafficOptions {
  /** Pause the stream (default true = running). */
  enabled?: boolean;
  /** Delay range between pings in ms (default [600, 1500]). */
  intervalMs?: readonly [number, number];
  /** How many recent pings to keep in `pings` (default 12). */
  maxPings?: number;
  /** Base size of the initial totals (default 48 per weight unit). */
  scale?: number;
}

export interface DemoTraffic {
  countries: GlobeCountryValue[];
  pings: GlobePing[];
  /** total value across all countries */
  total: number;
  /** pings emitted since mount */
  live: number;
  /** the latest ping, if any */
  last: GlobePing | null;
}

/**
 * Produces realistic fake `countries` and a stream of `pings` (every
 * ~0.6–1.5 s, weighted by rough internet population). Pauses while the tab
 * is hidden so it does not burst on return.
 */
export function useDemoTraffic(options: DemoTrafficOptions = {}): DemoTraffic {
  const { enabled = true, maxPings = 12, scale = 48 } = options;
  const [minMs, maxMs] = options.intervalMs ?? [600, 1500];
  const [state, setState] = useState<DemoTraffic>(() => {
    const countries = initialDemoCountries(scale);
    return { countries, pings: [], total: countries.reduce((s, c) => s + c.value, 0), live: 0, last: null };
  });
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const lo = Math.max(50, Math.min(minMs, maxMs));
    const hi = Math.max(lo, maxMs);
    const tick = () => {
      if (cancelled) return;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        const country = pickWeightedCountry(Math.random());
        seq.current += 1;
        const ping: GlobePing = { id: `demo-${Date.now().toString(36)}-${seq.current}`, country };
        setState((prev) => {
          const countries = prev.countries.map((c) => (c.country === country ? { ...c, value: c.value + 1 } : c));
          return {
            countries,
            pings: [...prev.pings, ping].slice(-Math.max(1, maxPings)),
            total: prev.total + 1,
            live: prev.live + 1,
            last: ping,
          };
        });
      }
      timer = setTimeout(tick, lo + Math.random() * (hi - lo));
    };
    timer = setTimeout(tick, lo * 0.5);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, minMs, maxMs, maxPings]);

  return state;
}
