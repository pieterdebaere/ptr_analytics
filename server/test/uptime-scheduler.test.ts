import { describe, expect, it } from 'vitest';
import { CheckLimiter, type Job } from '../src/uptime/engine/limiter.js';
import { MinHeap, Scheduler, nextAnchored, nextSlotAfter, phaseOf } from '../src/uptime/engine/scheduler.js';
import { FakeClock } from './uptime-core-fakes.js';

describe('MinHeap', () => {
  it('pops in due order, ties by sequence', () => {
    const h = new MinHeap();
    const dues = [50, 10, 40, 10, 30, 20, 60, 0];
    dues.forEach((due, i) => h.push({ id: i, due, seq: i }));
    const out: number[] = [];
    for (let e = h.pop(); e; e = h.pop()) out.push(e.id);
    expect(out).toEqual([7, 1, 3, 5, 4, 2, 0, 6]);
  });
});

describe('phase and anchoring', () => {
  it('phase is stable and within the interval', () => {
    const a = phaseOf('abcdefghijkl', 60_000);
    expect(a).toBe(phaseOf('abcdefghijkl', 60_000));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(60_000);
    const phases = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => phaseOf(`monitor${x}`, 60_000)));
    expect(phases.size).toBeGreaterThan(4); // spread
  });

  it('nextSlotAfter returns phase + k·interval strictly after t', () => {
    expect(nextSlotAfter(0, 5, 60)).toBe(5);
    expect(nextSlotAfter(5, 5, 60)).toBe(65);
    expect(nextSlotAfter(64, 5, 60)).toBe(65);
    expect(nextSlotAfter(1000, 5, 60)).toBe(1025);
  });

  it('anchored: no drift, missed slots are skipped (no burst)', () => {
    expect(nextAnchored(65, 70, 5, 60)).toBe(125); // check took 5 s: still the next slot
    expect(nextAnchored(65, 300, 5, 60)).toBe(305); // overran several slots: skip to the next one
  });
});

describe('Scheduler (fake monotonic clock)', () => {
  it('fires due entries in order and supports rescheduling', async () => {
    const clock = new FakeClock(1_000_000);
    const fired: Array<[number, number]> = [];
    const s = new Scheduler(clock, (id) => fired.push([id, clock.mono()]));
    s.start();
    s.schedule(1, clock.mono() + 5000);
    s.schedule(2, clock.mono() + 1000);
    s.schedule(3, clock.mono() + 3000);
    s.schedule(3, clock.mono() + 7000); // replaces the earlier entry
    await clock.advance(10_000);
    expect(fired).toEqual([
      [2, 1_001_000],
      [1, 1_005_000],
      [3, 1_007_000],
    ]);
    expect(s.size).toBe(0);
  });

  it('unschedule removes; long waits are re-armed in steps', async () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    const s = new Scheduler(clock, (id) => fired.push(id));
    s.start();
    s.schedule(1, 5 * 60_000);
    s.schedule(2, 1000);
    s.unschedule(2);
    await clock.advance(4 * 60_000);
    expect(fired).toEqual([]);
    await clock.advance(60_000);
    expect(fired).toEqual([1]);
  });

  it('a periodic monitor fires exactly once per interval, phase aligned', async () => {
    const clock = new FakeClock(0);
    const interval = 60_000;
    const phase = 7_000;
    const fired: number[] = [];
    const s: Scheduler = new Scheduler(clock, (id, due) => {
      fired.push(clock.mono());
      s.schedule(id, nextAnchored(due, clock.mono() + 3000 /* check takes 3 s */, phase, interval));
    });
    s.start();
    s.schedule(1, nextSlotAfter(clock.mono(), phase, interval));
    await clock.advance(5 * interval);
    expect(fired).toEqual([7_000, 67_000, 127_000, 187_000, 247_000]);
  });

  it('stop() cancels everything', async () => {
    const clock = new FakeClock(0);
    const fired: number[] = [];
    const s = new Scheduler(clock, (id) => fired.push(id));
    s.start();
    s.schedule(1, 100);
    s.stop();
    await clock.advance(1000);
    expect(fired).toEqual([]);
  });
});

describe('CheckLimiter', () => {
  function job(owner: number | null, dest: string | null, log: string[], name: string, deadline = Infinity): Job & { release?: () => void } {
    const j: Job & { release?: () => void } = {
      owner,
      dest,
      deadline,
      start(release) {
        log.push(`start ${name}`);
        j.release = release;
      },
      drop(reason) {
        log.push(`drop ${name} ${reason}`);
      },
    };
    return j;
  }

  it('enforces global, per-owner and per-(owner, destination) limits', () => {
    const log: string[] = [];
    const l = new CheckLimiter({ global: 3, perOwner: 1, perDestination: 2 }, () => 0);
    const a = job(1, 'x.com', log, 'a');
    const b = job(1, 'y.com', log, 'b'); // same member: waits
    const c = job(null, 'x.com', log, 'c');
    const d = job(null, 'x.com', log, 'd');
    const e = job(null, 'x.com', log, 'e'); // operator slots for x.com (2) taken, global full anyway
    for (const j of [a, b, c, d, e]) l.submit(j);
    expect(log).toEqual(['start a', 'start c', 'start d']);
    expect(l.active).toBe(3);
    expect(l.queued).toBe(2);
    a.release?.();
    expect(log.slice(3)).toEqual(['start b']);
    c.release?.();
    expect(log.slice(4)).toEqual(['start e']);
    a.release?.(); // double release is ignored
    expect(l.active).toBe(3);
  });

  it("one owner's in-flight checks never use another owner's destination slots or get its jobs dropped (SSRF M3)", () => {
    let now = 0;
    const log: string[] = [];
    const l = new CheckLimiter({ global: 100, perOwner: 50, perDestination: 2 }, () => now);
    // attackers park long checks on the victim's host
    const attackers: Array<ReturnType<typeof job>> = [];
    for (let owner = 10; owner < 18; owner++) for (let i = 0; i < 10; i++) attackers.push(job(owner, 'victim.example', log, `x${owner}.${i}`, 60_000));
    for (const j of attackers) l.submit(j);
    // the victim's own check starts at once and is never dropped
    const v = job(1, 'victim.example', log, 'victim', 60_000);
    l.submit(v);
    now = 120_000;
    l.submit(job(2, null, log, 'other'));
    expect(log).toContain('start victim');
    expect(log.some((x) => x.startsWith('drop victim'))).toBe(false);
    // attackers are limited to 2 per (owner, destination) and their surplus expires
    expect(log.filter((x) => x.startsWith('start x10.')).length).toBe(2);
    expect(log.filter((x) => x.startsWith('drop x10.')).length).toBe(8);
  });

  it('defers (never drops) budgeted jobs over the per-destination rate and shares the budget round robin (SSRF L3)', () => {
    let now = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const log: string[] = [];
    const l = new CheckLimiter({ global: 100, perOwner: 100, perDestination: 100, destPerMinute: 6 }, () => now, {
      set: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        const i = timers.indexOf(h as never);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const run = (owner: number, name: string, dest = 'victim.example'): void => {
      const j = job(owner, dest, log, name, 1000); // deadline long passed when the budget frees up
      j.budgeted = true;
      const start = j.start.bind(j);
      j.start = (release) => {
        start(release);
        release(); // instant checks
      };
      l.submit(j);
    };
    for (let i = 0; i < 10; i++) run(7, `a${i}`);
    run(8, 'b0');
    // operator jobs are not budgeted
    l.submit(job(null, 'victim.example', log, 'op'));
    expect(log.filter((x) => x.startsWith('start a')).length).toBe(6);
    expect(log).toContain('start op');
    expect(log).not.toContain('start b0');
    // other destinations are unaffected
    run(8, 'c0', 'other.example');
    expect(log).toContain('start c0');
    // one token every 10 s: owner 8 gets the next one (round robin), nothing is ever dropped
    const fire = (): void => {
      timers.sort((x, y) => x.at - y.at);
      const t = timers.shift();
      if (!t) return;
      now = Math.max(now, t.at);
      t.fn();
    };
    fire();
    expect(now).toBe(10_000);
    fire();
    expect(now).toBe(20_000);
    expect(log).toContain('start b0'); // owner 8 got one of the next two tokens
    for (let i = 0; i < 3; i++) fire();
    expect(log.filter((x) => x.startsWith('start a')).length).toBe(10);
    expect(log.some((x) => x.startsWith('drop'))).toBe(false);
    expect(l.queued).toBe(0);
  });

  it('serves owners round robin and drops jobs that waited too long', () => {
    let now = 0;
    const log: string[] = [];
    const l = new CheckLimiter({ global: 1, perOwner: 10, perDestination: 10 }, () => now);
    const first = job(null, null, log, 'first');
    l.submit(first);
    l.submit(job(1, null, log, 'a1'));
    l.submit(job(1, null, log, 'a2'));
    l.submit(job(2, null, log, 'b1'));
    l.submit(job(3, null, log, 'late', 50));
    now = 100;
    first.release?.();
    // global capacity was the only blocker of 'late': it expires; owners 1 and 2 are served in turn
    expect(log).toContain('drop late engine overloaded');
    expect(log.filter((x) => x.startsWith('start'))).toEqual(['start first', 'start a1']);
  });

  it('drain drops all waiting jobs', () => {
    const log: string[] = [];
    const l = new CheckLimiter({ global: 1, perOwner: 1, perDestination: 1 }, () => 0);
    l.submit(job(null, null, log, 'a'));
    l.submit(job(null, null, log, 'b'));
    l.drain('stopping');
    expect(log).toEqual(['start a', 'drop b stopping']);
  });
});
