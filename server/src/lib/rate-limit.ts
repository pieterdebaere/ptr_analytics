interface Entry {
  key: string;
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter keyed by string, with a hard cap on the number of tracked keys
 * so memory stays bounded even under a flood of distinct keys.
 *
 * Every operation is O(1) amortised. The window is constant, so entries are created in
 * expiry order; they are also appended to a FIFO queue. Sweeping pops expired entries from
 * the queue head and stops at the first live one, and when the map is full of live entries
 * only the head (the entry closest to expiry) is evicted. Each queued entry is popped at
 * most once. (A separate queue is used instead of iterating the Map from its start: V8
 * keeps deleted Map slots as holes until a rehash, so repeatedly reading the "first" key
 * after deletions is not O(1).) If the clock steps backwards the order may be slightly
 * off; that only delays sweeping, the size cap still holds.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  /** Entries in creation (= expiry) order; may contain stale entries (reset / replaced). */
  private queue: Entry[] = [];
  private head = 0;

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
      // Still full of live entries: evict only the head (the oldest, closest to expiry).
      while (this.entries.size >= this.maxKeys) {
        const oldest = this.shift();
        if (oldest === undefined) break;
        if (this.entries.get(oldest.key) === oldest) this.entries.delete(oldest.key);
      }
    }
    const entry: Entry = { key, count: 1, resetAt: this.now() + this.windowMs };
    this.entries.set(key, entry);
    this.push(entry);
    return 1 <= this.limit;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries from the head; stops at the first live entry. */
  sweep(): void {
    const now = this.now();
    while (this.head < this.queue.length) {
      const e = this.queue[this.head] as Entry;
      const live = this.entries.get(e.key) === e;
      if (live && e.resetAt > now) break;
      this.shift();
      if (live) this.entries.delete(e.key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private shift(): Entry | undefined {
    if (this.head >= this.queue.length) return undefined;
    const e = this.queue[this.head++];
    if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return e;
  }

  private push(e: Entry): void {
    this.queue.push(e);
    // Stale entries (keys that were reset or replaced) are only dropped when they reach the
    // head; rebuild from the map if they pile up so the queue stays O(maxKeys).
    if (this.queue.length - this.head > 2 * this.maxKeys + 1024) {
      this.queue = [...this.entries.values()].sort((a, b) => a.resetAt - b.resetAt);
      this.head = 0;
    }
  }
}
