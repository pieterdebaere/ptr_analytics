interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter keyed by string, with a hard cap on the number of tracked keys
 * so memory stays bounded even under a flood of distinct keys.
 *
 * Every operation is O(1) amortised. The window is constant and an expired key is deleted
 * before it is re-inserted, so the Map's insertion order is also expiry order: sweeping
 * walks from the head and stops at the first live entry (each entry is removed at most
 * once). When the map is full of live entries only the head (the entry closest to expiry)
 * is evicted. (If the clock moves backwards the order may be slightly off; that only
 * delays sweeping, the size cap still holds.)
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 50_000,
  ) {}

  private current(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && e.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  /** True when the key has reached the limit (does not count). */
  isLimited(key: string): boolean {
    const e = this.current(key);
    return e !== undefined && e.count >= this.limit;
  }

  /** Count one hit. Returns true if the hit is allowed (count <= limit). */
  hit(key: string): boolean {
    const e = this.current(key);
    if (e) {
      e.count++;
      return e.count <= this.limit;
    }
    if (this.entries.size >= this.maxKeys) {
      this.sweep();
      if (this.entries.size >= this.maxKeys) {
        // Still full of live entries: evict only the head (the oldest, closest to expiry).
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    return 1 <= this.limit;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries from the head; stops at the first live entry. */
  sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.resetAt > now) break;
      this.entries.delete(k);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
