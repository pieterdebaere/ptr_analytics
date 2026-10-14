// One timer + one min-heap keyed by due time on the engine clock (monotonic, ANALYSIS §8.3).
import { createHash } from 'node:crypto';

export interface EngineClock {
  /** Wall clock (ms epoch) for timestamps. */
  wall(): number;
  /** Monotonic clock (ms) for scheduling. */
  mono(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realClock = (wall: () => number): EngineClock => ({
  wall,
  mono: () => performance.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
});

interface Entry {
  id: number;
  due: number;
  seq: number;
}

/** Binary min-heap ordered by (due, seq). */
export class MinHeap {
  private readonly a: Entry[] = [];

  get size(): number {
    return this.a.length;
  }

  peek(): Entry | undefined {
    return this.a[0];
  }

  push(e: Entry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i] as Entry, a[p] as Entry)) break;
      [a[i], a[p]] = [a[p] as Entry, a[i] as Entry];
      i = p;
    }
  }

  pop(): Entry | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l] as Entry, a[m] as Entry)) m = l;
        if (r < a.length && less(a[r] as Entry, a[m] as Entry)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m] as Entry, a[i] as Entry];
        i = m;
      }
    }
    return top;
  }

  clear(): void {
    this.a.length = 0;
  }
}

const less = (x: Entry, y: Entry): boolean => x.due < y.due || (x.due === y.due && x.seq < y.seq);

/** Stable phase in [0, intervalMs) derived from the monitor uid (spreads load, survives restarts). */
export function phaseOf(uid: string, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  const h = createHash('sha256').update(uid).digest();
  const n = h.readUInt32BE(0) * 2 ** 16 + h.readUInt16BE(4); // 48 bits
  return n % intervalMs;
}

/** First slot `phase + k·interval` strictly after `t` (times on the engine clock, wall aligned). */
export function nextSlotAfter(t: number, phase: number, intervalMs: number): number {
  const k = Math.floor((t - phase) / intervalMs) + 1;
  return phase + k * intervalMs;
}

/**
 * Anchored scheduling: the next run is the previous *scheduled* time + interval; when the check
 * overran that slot (or the process stalled), missed slots are skipped instead of bursting.
 */
export function nextAnchored(prevDue: number, now: number, phase: number, intervalMs: number): number {
  const next = prevDue + intervalMs;
  if (next > now) return next;
  return nextSlotAfter(now, phase, intervalMs);
}

/** Longest single timer; long waits are re-armed (setTimeout limit, clock sanity). */
const MAX_TIMER_MS = 60_000;

/**
 * Min-heap scheduler with lazy invalidation: re-scheduling an id bumps its generation, stale heap
 * entries are skipped when popped.
 */
export class Scheduler {
  private readonly heap = new MinHeap();
  private readonly current = new Map<number, { seq: number; due: number }>(); // live entry per id
  private seq = 0;
  private timer: unknown = null;
  private timerDue = Infinity;
  private running = false;

  constructor(
    private readonly clock: EngineClock,
    private readonly onDue: (id: number, due: number) => void,
  ) {}

  start(): void {
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerDue = Infinity;
  }

  schedule(id: number, due: number): void {
    const seq = ++this.seq;
    this.current.set(id, { seq, due });
    this.heap.push({ id, due, seq });
    // Frequent re-scheduling (push monitors) leaves stale entries behind: rebuild when they pile up.
    if (this.heap.size > 2 * this.current.size + 1024) {
      this.heap.clear();
      for (const [eid, e] of this.current) this.heap.push({ id: eid, due: e.due, seq: e.seq });
    }
    if (due < this.timerDue) this.arm();
  }

  unschedule(id: number): void {
    this.current.delete(id);
  }

  has(id: number): boolean {
    return this.current.has(id);
  }

  /** Due time of the live entry (tests / diagnostics). */
  dueOf(id: number): number | undefined {
    return this.current.get(id)?.due;
  }

  get size(): number {
    return this.current.size;
  }

  private arm(): void {
    if (!this.running) return;
    this.dropStale();
    const top = this.heap.peek();
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.timerDue = Infinity;
    if (!top) return;
    const now = this.clock.mono();
    const wait = Math.max(0, Math.min(MAX_TIMER_MS, top.due - now));
    this.timerDue = now + wait;
    this.timer = this.clock.setTimer(() => this.tick(), wait);
  }

  private dropStale(): void {
    for (let top = this.heap.peek(); top !== undefined && this.current.get(top.id)?.seq !== top.seq; top = this.heap.peek()) this.heap.pop();
  }

  private tick(): void {
    this.timer = null;
    this.timerDue = Infinity;
    if (!this.running) return;
    const now = this.clock.mono();
    // Bounded batch per tick so a huge backlog cannot monopolise the event loop.
    for (let n = 0; n < 1000; n++) {
      this.dropStale();
      const top = this.heap.peek();
      if (!top || top.due > now) break;
      this.heap.pop();
      this.current.delete(top.id);
      try {
        this.onDue(top.id, top.due);
      } catch {
        // onDue must not throw; never let one monitor stop the scheduler
      }
    }
    this.arm();
  }
}
