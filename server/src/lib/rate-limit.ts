interface Entry {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter keyed by string, with a hard cap on the number of tracked keys
 * so memory stays bounded even under a flood of distinct keys.
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
      // Still full: evict the oldest key (Map preserves insertion order).
      while (this.entries.size >= this.maxKeys) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    return 1 <= this.limit;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries. */
  sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
  }

  get size(): number {
    return this.entries.size;
  }
}
