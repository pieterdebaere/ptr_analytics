import { describe, expect, it } from 'vitest';
import {
  isImportantBeat,
  isImportantForNotification,
  nextState,
  transition,
  type TransitionInput,
  type TransitionSettings,
  type TransitionState,
} from '../src/uptime/engine/transition.js';

const D = 0;
const U = 1;
const P = 2;
const M = 3;

const fresh = (): TransitionState => ({ status: -1, retries: 0, failedSinceNotify: 0, outageOpen: false, outageConfirmed: false });
const ok: TransitionInput = { kind: 'check', ok: true, msg: '200 OK', latencyMs: 42 };
const fail: TransitionInput = { kind: 'check', ok: false, msg: 'connection refused' };
const settings = (s: Partial<TransitionSettings> = {}): TransitionSettings => ({ maxRetries: 0, resendEvery: 0, upsideDown: false, ...s });

/** Run a sequence of inputs ('u' ok, 'd' fail, 'm' maintenance) and collect statuses + notifications. */
function run(seq: string, s: TransitionSettings, start = fresh()): { statuses: number[]; notify: Array<string | null>; important: boolean[]; state: TransitionState } {
  let state = start;
  const statuses: number[] = [];
  const notify: Array<string | null> = [];
  const important: boolean[] = [];
  for (const c of seq) {
    const out = transition(state, c === 'u' ? ok : fail, s, c === 'm');
    statuses.push(out.status);
    notify.push(out.notify);
    important.push(out.important);
    state = nextState(state, out);
  }
  return { statuses, notify, important, state };
}

describe('important beats (Kuma isImportantBeat / isImportantForNotification)', () => {
  const cases: Array<[number, number, boolean, boolean]> = [
    // prev, cur, important, notify
    [U, D, true, true],
    [P, D, true, true],
    [D, U, true, true],
    [M, U, true, false],
    [M, D, true, true],
    [U, M, true, false],
    [D, M, true, false],
    [U, P, false, false],
    [P, U, false, false],
    [P, P, false, false],
    [U, U, false, false],
    [D, D, false, false],
    [M, M, false, false],
    [P, M, false, false],
    [M, P, false, false],
  ];
  for (const [prev, cur, imp, notif] of cases) {
    it(`${prev} -> ${cur}: important=${imp} notify=${notif}`, () => {
      expect(isImportantBeat(false, prev, cur)).toBe(imp);
      expect(isImportantForNotification(false, prev, cur)).toBe(notif);
    });
  }

  it('the first beat is always important but only notifies when DOWN', () => {
    for (const cur of [U, D, P, M]) {
      expect(isImportantBeat(true, -1, cur)).toBe(true);
      expect(isImportantForNotification(true, -1, cur)).toBe(cur === D);
    }
  });
});

describe('transition()', () => {
  it('first beat UP: important, no notification', () => {
    const out = transition(fresh(), ok, settings(), false);
    expect(out).toMatchObject({ status: U, important: true, notify: null, latencyMs: 42, retries: 0 });
  });

  it('first beat DOWN notifies', () => {
    const out = transition(fresh(), fail, settings(), false);
    expect(out).toMatchObject({ status: D, important: true, notify: 'down', retries: 1 });
    expect(out.latencyMs).toBeNull();
  });

  it('without retries a failure goes straight to DOWN and notifies once', () => {
    const r = run('uuddduu', settings());
    expect(r.statuses).toEqual([U, U, D, D, D, U, U]);
    expect(r.notify).toEqual([null, null, 'down', null, null, 'up', null]);
    expect(r.important).toEqual([true, false, true, false, false, true, false]);
  });

  it('retries: failures are PENDING until maxRetries is exhausted', () => {
    const r = run('udddddu', settings({ maxRetries: 2 }));
    expect(r.statuses).toEqual([U, P, P, D, D, D, U]);
    expect(r.notify).toEqual([null, null, null, 'down', null, null, 'up']);
  });

  it('a flap that recovers while pending never notifies (UP -> PENDING -> UP)', () => {
    const r = run('uduuddu', settings({ maxRetries: 2 }));
    expect(r.statuses).toEqual([U, P, U, U, P, P, U]);
    expect(r.notify.every((n) => n === null)).toBe(true);
  });

  it('DOWN never goes back to PENDING: retries keep counting while down', () => {
    const r = run('ddddd', settings({ maxRetries: 1 }));
    expect(r.statuses).toEqual([P, D, D, D, D]);
    expect(r.state.retries).toBe(5);
  });

  it('first beat PENDING (with retries) then DOWN notifies on DOWN', () => {
    const r = run('dd', settings({ maxRetries: 1 }));
    expect(r.statuses).toEqual([P, D]);
    expect(r.notify).toEqual([null, 'down']);
  });

  it('resend every N consecutive non-important DOWN beats', () => {
    const r = run('udddddddu', settings({ resendEvery: 3 }));
    // beat 2 = DOWN (notify), then 3 non-important downs -> resend, 3 more -> resend
    expect(r.notify).toEqual([null, 'down', null, null, 'resend', null, null, 'resend', 'up']);
  });

  it('resend counter resets on an important beat', () => {
    const r = run('ddudd' + 'd', settings({ resendEvery: 2 }));
    // d(first, notify) d(1) u(important, reset) d(notify) d(1) d(2 -> resend)
    expect(r.notify).toEqual(['down', null, 'up', 'down', null, 'resend']);
  });

  it('upside-down: a failing check is UP, a successful one is a failure', () => {
    const s = settings({ upsideDown: true });
    const a = transition(fresh(), fail, s, false);
    expect(a.status).toBe(U);
    expect(a.msg).toBe('connection refused');
    expect(a.latencyMs).toBeNull();
    const b = transition(nextState(fresh(), a), ok, s, false);
    expect(b.status).toBe(D);
    expect(b.notify).toBe('down');
    expect(b.msg).toMatch(/upside-down/);
  });

  it('upside-down with retries: an unexpected success goes through PENDING', () => {
    const s = settings({ upsideDown: true, maxRetries: 1 });
    let st = nextState(fresh(), transition(fresh(), fail, s, false));
    const p = transition(st, ok, s, false);
    expect(p.status).toBe(P);
    st = nextState(st, p);
    expect(transition(st, ok, s, false).status).toBe(D);
  });

  it('maintenance: status 3, retries reset, entering and leaving UP are silent', () => {
    const r = run('umu', settings());
    expect(r.statuses).toEqual([U, M, U]);
    expect(r.notify).toEqual([null, null, null]);
    expect(r.important).toEqual([true, true, true]);
  });

  it('maintenance suppresses DOWN notifications; coming out DOWN notifies', () => {
    const r = run('ddmmd', settings());
    expect(r.statuses).toEqual([D, D, M, M, D]);
    expect(r.notify).toEqual(['down', null, null, null, 'down']);
  });

  it('maintenance resets retries and stops resends', () => {
    const r = run('ddmdddd', settings({ resendEvery: 2, maxRetries: 0 }));
    expect(r.notify).toEqual(['down', null, null, 'down', null, 'resend', null]);
    const withRetries = run('udmd', settings({ maxRetries: 3 }));
    expect(withRetries.statuses).toEqual([U, P, M, P]);
  });

  it('custom statuses (group/manual) bypass retries and inversion', () => {
    const s = settings({ maxRetries: 5, upsideDown: true });
    const out = transition(fresh(), { kind: 'custom', status: 0, msg: 'Child inaccessible' }, s, false);
    expect(out.status).toBe(D);
    expect(out.notify).toBe('down');
    const up = transition(nextState(fresh(), out), { kind: 'custom', status: 1, msg: 'ok' }, s, false);
    expect(up.status).toBe(U);
    expect(up.notify).toBe('up');
  });

  describe('outages', () => {
    it('open on the first failure, confirm on DOWN, close on recovery', () => {
      let st = nextState(fresh(), transition(fresh(), ok, settings({ maxRetries: 1 }), false));
      const a = transition(st, fail, settings({ maxRetries: 1 }), false);
      expect(a.outage).toEqual({ open: true, confirm: false, close: false });
      st = nextState(st, a);
      const b = transition(st, fail, settings({ maxRetries: 1 }), false);
      expect(b.outage).toEqual({ open: false, confirm: true, close: false });
      st = nextState(st, b);
      const c = transition(st, fail, settings({ maxRetries: 1 }), false);
      expect(c.outage).toEqual({ open: false, confirm: false, close: false });
      st = nextState(st, c);
      const d = transition(st, ok, settings({ maxRetries: 1 }), false);
      expect(d.outage).toEqual({ open: false, confirm: false, close: true });
      expect(nextState(st, d)).toMatchObject({ outageOpen: false, outageConfirmed: false });
    });

    it('a direct DOWN opens and confirms at once', () => {
      const out = transition(fresh(), fail, settings(), false);
      expect(out.outage).toEqual({ open: true, confirm: true, close: false });
    });

    it('an unconfirmed flap is closed on recovery', () => {
      const st = nextState(fresh(), transition(fresh(), fail, settings({ maxRetries: 2 }), false));
      expect(st).toMatchObject({ outageOpen: true, outageConfirmed: false });
      expect(transition(st, ok, settings({ maxRetries: 2 }), false).outage.close).toBe(true);
    });

    it('maintenance closes an open outage', () => {
      const st = nextState(fresh(), transition(fresh(), fail, settings(), false));
      expect(transition(st, ok, settings(), true).outage.close).toBe(true);
    });
  });
});
