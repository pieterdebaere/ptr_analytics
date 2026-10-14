// Concurrency limits for checks (ANALYSIS §8.3): global, per owner (hosted members) and per
// destination host. Waiting jobs are served fairly between owners (round robin).

export interface LimitOptions {
  global: number;
  /** Per member-owned account; operator monitors (owner null) only count against the global limit. */
  perOwner: number;
  perDestination: number;
}

export interface Job {
  owner: number | null;
  /** Destination host (lower case), null when the check has no network destination. */
  dest: string | null;
  /** Called once the slots are held; must eventually call `release()` exactly once. */
  start(release: () => void): void;
  /** Called instead of start() when the job is dropped (waited too long, engine stopping). */
  drop(reason: string): void;
  /** Drop when still waiting at this engine time. */
  deadline: number;
}

const OPERATOR = 'op';

export class CheckLimiter {
  private inFlight = 0;
  private readonly perOwner = new Map<string, number>();
  private readonly perDest = new Map<string, number>();
  /** Waiting jobs per owner key; `order` is the round-robin rotation of owner keys. */
  private readonly waiting = new Map<string, Job[]>();
  private order: string[] = [];
  private rr = 0;

  constructor(
    private readonly opts: LimitOptions,
    private readonly now: () => number,
  ) {}

  get active(): number {
    return this.inFlight;
  }

  get queued(): number {
    let n = 0;
    for (const q of this.waiting.values()) n += q.length;
    return n;
  }

  private ownerKey(job: Job): string {
    return job.owner === null ? OPERATOR : `u${job.owner}`;
  }

  private fits(job: Job): boolean {
    if (this.inFlight >= this.opts.global) return false;
    if (job.owner !== null && (this.perOwner.get(this.ownerKey(job)) ?? 0) >= this.opts.perOwner) return false;
    if (job.dest !== null && (this.perDest.get(job.dest) ?? 0) >= this.opts.perDestination) return false;
    return true;
  }

  submit(job: Job): void {
    if (this.queued === 0 && this.fits(job)) {
      this.run(job);
      return;
    }
    const key = this.ownerKey(job);
    let q = this.waiting.get(key);
    if (!q) {
      q = [];
      this.waiting.set(key, q);
      this.order.push(key);
    }
    q.push(job);
    this.pump();
  }

  /** Drop every waiting job (engine stop). */
  drain(reason: string): void {
    const all = [...this.waiting.values()].flat();
    this.waiting.clear();
    this.order = [];
    for (const j of all) safe(() => j.drop(reason));
  }

  private run(job: Job): void {
    const key = this.ownerKey(job);
    this.inFlight++;
    if (job.owner !== null) this.perOwner.set(key, (this.perOwner.get(key) ?? 0) + 1);
    if (job.dest !== null) this.perDest.set(job.dest, (this.perDest.get(job.dest) ?? 0) + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight--;
      if (job.owner !== null) dec(this.perOwner, key);
      if (job.dest !== null) dec(this.perDest, job.dest);
      this.pump();
    };
    try {
      job.start(release);
    } catch {
      release();
    }
  }

  private pump(): void {
    const now = this.now();
    // Expire jobs that waited too long (recorded as "no data", never as DOWN).
    for (const [key, q] of this.waiting) {
      const keep = q.filter((j) => {
        if (j.deadline > now) return true;
        safe(() => j.drop('engine overloaded'));
        return false;
      });
      if (keep.length === 0) this.waiting.delete(key);
      else this.waiting.set(key, keep);
    }
    this.order = this.order.filter((k) => this.waiting.has(k));
    let progressed = true;
    while (progressed && this.inFlight < this.opts.global && this.order.length > 0) {
      progressed = false;
      for (let i = 0; i < this.order.length; i++) {
        const idx = (this.rr + i) % this.order.length;
        const key = this.order[idx] as string;
        const q = this.waiting.get(key);
        if (!q) continue;
        const pos = q.findIndex((j) => this.fits(j));
        if (pos === -1) continue;
        const [job] = q.splice(pos, 1);
        if (q.length === 0) {
          this.waiting.delete(key);
          this.order.splice(idx, 1);
          this.rr = this.order.length > 0 ? idx % this.order.length : 0;
        } else {
          this.rr = (idx + 1) % this.order.length;
        }
        if (job) this.run(job);
        progressed = true;
        break;
      }
    }
  }
}

function dec(map: Map<string, number>, key: string): void {
  const n = (map.get(key) ?? 1) - 1;
  if (n <= 0) map.delete(key);
  else map.set(key, n);
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignore
  }
}
