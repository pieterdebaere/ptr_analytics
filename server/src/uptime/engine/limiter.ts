// Concurrency limits and per-destination request budgets for checks (ANALYSIS §8.3, §8.7.2).
//
// * global: checks in flight on this server;
// * per owner: checks in flight per hosted member (operator monitors only count globally);
// * per (owner, destination): checks in flight per owner to one destination. The slots are keyed
//   by owner so that one tenant's slow or hanging checks can never occupy another tenant's slots
//   (audit SSRF M3: attackers parking 30 s checks on a victim's host made the victim's own checks
//   expire as "no data");
// * per destination budget: a token bucket of `destPerMinute` requests per minute shared by every
//   budgeted job (hosted members) to the same destination, so the number of accounts does not
//   multiply the traffic one destination receives (audit SSRF L3). A job without budget is
//   deferred (kept in the queue until a token is available), never dropped: the monitor is only
//   checked a little later. Owners are served round robin, so each gets a fair share of a
//   contended budget.
//
// Waiting jobs expire after their deadline ("engine overloaded", recorded as no data) only when
// they wait for the global slots or for their own owner's slots — never because of other owners.

export interface LimitOptions {
  global: number;
  /** Per member-owned account; operator monitors (owner null) only count against the global limit. */
  perOwner: number;
  /** Concurrent checks per (owner, destination). */
  perDestination: number;
  /** Requests per minute per destination for budgeted jobs; 0 / undefined = no budget. */
  destPerMinute?: number;
}

export interface Job {
  owner: number | null;
  /** Normalised destination key (lower-case host without trailing dot, or canonical IP), null when the check has no network destination. */
  dest: string | null;
  /** Counts against the shared per-destination budget (hosted members). */
  budgeted?: boolean;
  /** Called once the slots are held; must eventually call `release()` exactly once. */
  start(release: () => void): void;
  /** Called instead of start() when the job is dropped (waited too long, engine stopping). */
  drop(reason: string): void;
  /** Drop when still waiting (for global or own-owner slots) at this engine time. */
  deadline: number;
}

export interface LimiterTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

type Blocker = 'global' | 'owner' | 'dest' | 'budget' | null;

const OPERATOR = 'op';
const MAX_BUCKETS = 20_000;

const defaultTimers: LimiterTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class CheckLimiter {
  private inFlight = 0;
  private readonly perOwner = new Map<string, number>();
  private readonly perDest = new Map<string, number>();
  /** Token buckets per destination: tokens available at `at` (engine time). */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Waiting jobs per owner key; `order` is the round-robin rotation of owner keys. */
  private readonly waiting = new Map<string, Job[]>();
  private order: string[] = [];
  /** Jobs that waited for the destination budget at some point: deferred, never expired. */
  private readonly deferred = new WeakSet<Job>();
  private rr = 0;
  private budgetTimer: unknown = null;
  private budgetTimerAt = Infinity;

  constructor(
    private readonly opts: LimitOptions,
    private readonly now: () => number,
    private readonly timers: LimiterTimers = defaultTimers,
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

  private destKey(job: Job): string {
    return `${this.ownerKey(job)}|${job.dest}`;
  }

  private get rate(): number {
    const n = this.opts.destPerMinute ?? 0;
    return n > 0 ? n : 0;
  }

  /** Tokens of a destination's bucket now (refilled lazily). */
  private tokens(dest: string, now: number): number {
    const cap = this.rate;
    const b = this.buckets.get(dest);
    if (!b) return cap;
    return Math.min(cap, b.tokens + ((now - b.at) * cap) / 60_000);
  }

  private takeToken(dest: string, now: number): void {
    const left = this.tokens(dest, now) - 1;
    this.buckets.delete(dest);
    this.buckets.set(dest, { tokens: left, at: now });
    if (this.buckets.size > MAX_BUCKETS) {
      // Full buckets carry no information: forget them first, then the oldest.
      for (const [k] of this.buckets) {
        if (this.buckets.size <= MAX_BUCKETS / 2) break;
        if (this.tokens(k, now) >= this.rate) this.buckets.delete(k);
      }
      while (this.buckets.size > MAX_BUCKETS) {
        const oldest = this.buckets.keys().next();
        if (oldest.done) break;
        this.buckets.delete(oldest.value);
      }
    }
  }

  private blocker(job: Job, now: number): Blocker {
    if (this.inFlight >= this.opts.global) return 'global';
    if (job.owner !== null && (this.perOwner.get(this.ownerKey(job)) ?? 0) >= this.opts.perOwner) return 'owner';
    if (job.dest !== null && (this.perDest.get(this.destKey(job)) ?? 0) >= this.opts.perDestination) return 'dest';
    if (job.budgeted && job.dest !== null && this.rate > 0 && this.tokens(job.dest, now) < 1) return 'budget';
    return null;
  }

  submit(job: Job): void {
    if (this.queued === 0 && this.blocker(job, this.now()) === null) {
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
    if (this.budgetTimer !== null) this.timers.clear(this.budgetTimer);
    this.budgetTimer = null;
    this.budgetTimerAt = Infinity;
    for (const j of all) safe(() => j.drop(reason));
  }

  private run(job: Job): void {
    const key = this.ownerKey(job);
    const dkey = job.dest !== null ? this.destKey(job) : null;
    this.inFlight++;
    if (job.owner !== null) this.perOwner.set(key, (this.perOwner.get(key) ?? 0) + 1);
    if (dkey !== null) this.perDest.set(dkey, (this.perDest.get(dkey) ?? 0) + 1);
    if (job.budgeted && job.dest !== null && this.rate > 0) this.takeToken(job.dest, this.now());
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight--;
      if (job.owner !== null) dec(this.perOwner, key);
      if (dkey !== null) dec(this.perDest, dkey);
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
    // Expire jobs that waited too long for capacity (recorded as "no data", never as DOWN). Jobs
    // that only wait for the shared destination budget are deferred, not dropped.
    for (const [key, q] of this.waiting) {
      const keep = q.filter((j) => {
        if (this.deferred.has(j)) return true;
        const b = this.blocker(j, now);
        if (b === 'budget') {
          this.deferred.add(j);
          return true;
        }
        if (j.deadline > now) return true;
        safe(() => j.drop('engine overloaded'));
        return false;
      });
      if (keep.length === 0) this.waiting.delete(key);
      else this.waiting.set(key, keep);
    }
    this.order = this.order.filter((k) => this.waiting.has(k));
    if (this.rr >= this.order.length) this.rr = 0;
    let progressed = true;
    while (progressed && this.inFlight < this.opts.global && this.order.length > 0) {
      progressed = false;
      for (let i = 0; i < this.order.length; i++) {
        const idx = (this.rr + i) % this.order.length;
        const key = this.order[idx] as string;
        const q = this.waiting.get(key);
        if (!q) continue;
        const pos = q.findIndex((j) => this.blocker(j, now) === null);
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
    this.armBudgetTimer(now);
  }

  /** Wake up when the next token of a destination some waiting job needs becomes available. */
  private armBudgetTimer(now: number): void {
    const rate = this.rate;
    let wait = Infinity;
    if (rate > 0) {
      for (const q of this.waiting.values()) {
        for (const j of q) {
          if (!j.budgeted || j.dest === null) continue;
          const t = this.tokens(j.dest, now);
          if (t >= 1) continue;
          wait = Math.min(wait, Math.ceil(((1 - t) * 60_000) / rate));
        }
      }
    }
    if (wait === Infinity) {
      if (this.budgetTimer !== null) this.timers.clear(this.budgetTimer);
      this.budgetTimer = null;
      this.budgetTimerAt = Infinity;
      return;
    }
    const at = now + Math.max(1, wait);
    if (this.budgetTimer !== null && this.budgetTimerAt <= at) return;
    if (this.budgetTimer !== null) this.timers.clear(this.budgetTimer);
    this.budgetTimerAt = at;
    this.budgetTimer = this.timers.set(() => {
      this.budgetTimer = null;
      this.budgetTimerAt = Infinity;
      this.pump();
    }, Math.max(1, wait));
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
