// Small bounded TTL caches and per-IP limiters for the public status endpoints.
import type { AppContext } from '../../context.js';
import { RateLimiter } from '../../lib/rate-limit.js';

/** Bounded TTL map (insertion-ordered eviction). */
export class TtlCache<V> {
  private readonly map = new Map<string, { expires: number; value: V }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
    this.map.set(key, { expires: this.now() + this.ttlMs, value });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Cached entries older than this are re-validated against the database (cheap indexed
 * lookups) before being served, so a deleted site, an unpublished page or a disabled /
 * regenerated badge id stops being served within seconds even when no code path called
 * invalidatePublic().
 */
export const REVALIDATE_MS = 5_000;

/** A cached public value plus what it was rendered for (see REVALIDATE_MS). */
export interface Checked<V> {
  value: V;
  /** Validity fingerprint at render time (e.g. the monitor id behind a badge id, or null). */
  fingerprint: string;
  checkedAt: number;
}

export interface PublicState {
  /** Public status JSON by slug (30 s, re-validated after 5 s). */
  pages: TtlCache<Checked<unknown>>;
  /** Rendered badge SVGs by normalised parameters (60 s, re-validated after 5 s). */
  badges: TtlCache<Checked<string>>;
  limits: {
    status: RateLimiter;
    badge: RateLimiter;
    feed: RateLimiter;
    asset: RateLimiter;
    misc: RateLimiter;
  };
}

const states = new WeakMap<AppContext, PublicState>();

export const STATUS_CACHE_TTL_MS = 30_000;
export const BADGE_CACHE_TTL_MS = 60_000;

export function publicState(ctx: AppContext): PublicState {
  let s = states.get(ctx);
  if (!s) {
    const now = ctx.now;
    s = {
      pages: new TtlCache(STATUS_CACHE_TTL_MS, 1000, now),
      badges: new TtlCache(BADGE_CACHE_TTL_MS, 5000, now),
      limits: {
        status: new RateLimiter(120, 60_000, now, 50_000),
        badge: new RateLimiter(600, 60_000, now, 50_000),
        feed: new RateLimiter(30, 60_000, now, 50_000),
        asset: new RateLimiter(300, 60_000, now, 50_000),
        misc: new RateLimiter(60, 60_000, now, 50_000),
      },
    };
    states.set(ctx, s);
  }
  return s;
}

/**
 * Drop cached public output after a change: status page, incident, logo, domains — and
 * (for other modules) badge enable / disable / regenerate, monitor rename / delete, site
 * deletion or suspension. Cheap; call it after any change that public pages or badges show.
 */
export function invalidatePublic(ctx: AppContext): void {
  const s = states.get(ctx);
  s?.pages.clear();
  s?.badges.clear();
}
