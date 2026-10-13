// Ping bookkeeping: each ping id animates once, the set of seen ids is bounded.

import type { LonLat } from './geo';

export interface ActivePing {
  id: string;
  country: string;
  lon: number;
  lat: number;
  /** start time (ms, same clock as `now`) */
  start: number;
}

export interface PingInput {
  id: string;
  country: string;
}

export interface PingTrackerOptions {
  /** how long one ping animates (ms) */
  duration?: number;
  /** max remembered ids (oldest evicted first) */
  maxSeen?: number;
  /** max simultaneously animating pings (oldest dropped first) */
  maxActive?: number;
}

export type PingLocator = (ping: PingInput) => LonLat | null;

export class PingTracker {
  readonly duration: number;
  readonly maxSeen: number;
  readonly maxActive: number;
  private readonly seen = new Set<string>();
  private active: ActivePing[] = [];

  constructor(opts: PingTrackerOptions = {}) {
    this.duration = opts.duration ?? 2500;
    this.maxSeen = Math.max(1, opts.maxSeen ?? 1000);
    this.maxActive = Math.max(1, opts.maxActive ?? 64);
  }

  /**
   * Registers pings; ids seen before are ignored. Pings whose country cannot
   * be located are remembered (so they are not retried) but not animated.
   * Returns the number of newly animating pings.
   */
  ingest(pings: readonly PingInput[] | undefined | null, now: number, locate: PingLocator): number {
    if (!pings || pings.length === 0) return 0;
    let added = 0;
    for (const p of pings) {
      if (!p || typeof p.id !== 'string' || this.seen.has(p.id)) continue;
      this.remember(p.id);
      const at = locate(p);
      if (!at) continue;
      this.active.push({ id: p.id, country: p.country, lon: at[0], lat: at[1], start: now });
      added++;
    }
    if (this.active.length > this.maxActive) this.active.splice(0, this.active.length - this.maxActive);
    return added;
  }

  /** Marks ids as seen without animating them (e.g. history present on mount). */
  markSeen(pings: readonly PingInput[] | undefined | null): void {
    if (!pings) return;
    for (const p of pings) if (p && typeof p.id === 'string' && !this.seen.has(p.id)) this.remember(p.id);
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.maxSeen) {
      // Sets iterate in insertion order: drop the oldest.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Drops finished pings; returns the ones still animating. */
  prune(now: number): readonly ActivePing[] {
    if (this.active.length > 0) {
      const d = this.duration;
      this.active = this.active.filter((p) => now - p.start < d);
    }
    return this.active;
  }

  /** Animation progress in [0, 1] (values >= 1 are finished). */
  progress(p: ActivePing, now: number): number {
    return Math.max(0, (now - p.start) / this.duration);
  }

  /** Time (ms) until the next active ping finishes, or null. */
  nextExpiry(now: number): number | null {
    let best: number | null = null;
    for (const p of this.active) {
      const left = p.start + this.duration - now;
      if (best === null || left < best) best = left;
    }
    return best === null ? null : Math.max(0, best);
  }

  get activeCount(): number {
    return this.active.length;
  }

  get seenCount(): number {
    return this.seen.size;
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  clear(): void {
    this.active = [];
  }
}
