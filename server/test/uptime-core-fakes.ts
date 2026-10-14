// Test doubles for the uptime core: a fake engine clock and fake checker definitions injected
// through uptime/runtime.ts (the real registry is never edited).
import type { EngineClock } from '../src/uptime/engine/scheduler.js';
import type { CheckerMap } from '../src/uptime/runtime.js';
import { ValidationError, type CheckContext, type CheckResult, type CheckerDefinition, type SafeNet } from '../src/uptime/types.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock: wall() and mono() advance together; timers fire in order during advance(). */
export class FakeClock implements EngineClock {
  private timers: Timer[] = [];
  private seq = 0;
  /** Shared with the app's test clock (ctx.now) when given an object. */
  private readonly state: { t: number };

  constructor(
    t: number | { t: number },
    /** wall = t + wallOffset (lets tests step the wall clock independently). */
    public wallOffset = 0,
  ) {
    this.state = typeof t === 'number' ? { t } : t;
  }

  get t(): number {
    return this.state.t;
  }

  set t(v: number) {
    this.state.t = v;
  }

  wall(): number {
    return this.t + this.wallOffset;
  }

  mono(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): unknown {
    const timer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  get pending(): number {
    return this.timers.length;
  }

  /** Advance time, firing due timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await settle();
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
    await settle();
  }
}

/** Let pending promise callbacks (and one macrotask turn) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

export type Scripted = CheckResult | ((ctx: CheckContext) => Promise<CheckResult> | CheckResult);

/** Results per monitor uid (default: up). */
export class FakeResults {
  readonly byUid = new Map<string, Scripted>();
  readonly calls: Array<{ uid: string; secrets: Record<string, string>; config: Record<string, unknown> }> = [];
  set(uid: string, r: Scripted): void {
    this.byUid.set(uid, r);
  }
}

interface FakeConfig {
  url: string;
}

export function fakeHttpChecker(results: FakeResults, type = 'fakehttp', hosted: 'allowed' | 'restricted' | 'disabled' = 'allowed'): CheckerDefinition<FakeConfig, Record<string, string>> {
  return {
    type,
    label: `Fake ${type}`,
    description: 'test double',
    category: 'web',
    fields: [
      { key: 'url', label: 'URL', kind: 'url', required: true },
      { key: 'password', label: 'Password', kind: 'password', secret: true },
    ],
    defaults: { intervalS: 60, timeoutMs: 10_000, retries: 0 },
    hosted,
    validate(input, ctx) {
      const url = input['url'];
      if (typeof url !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:\d+)?\//.test(url)) throw new ValidationError('url must be an http(s) URL', 'url');
      const secrets: Record<string, string> = { ...(ctx.existingSecrets ?? {}) };
      const pw = input['password'];
      if (pw === null) delete secrets['password'];
      else if (typeof pw === 'string' && pw !== '') secrets['password'] = pw;
      return { config: { url }, secrets };
    },
    async check(ctx) {
      results.calls.push({ uid: ctx.monitorUid, secrets: ctx.secrets, config: ctx.config as unknown as Record<string, unknown> });
      const r = results.byUid.get(ctx.monitorUid) ?? { status: 'up', msg: '200 OK', latencyMs: 25 };
      return typeof r === 'function' ? r(ctx as unknown as CheckContext) : r;
    },
    target: (c) => c.url,
    certHost: (c) => new URL(c.url).hostname,
  };
}

const empty = (type: 'push' | 'group' | 'manual'): CheckerDefinition<Record<string, never>, Record<string, never>> => ({
  type,
  label: type,
  description: type,
  category: 'passive',
  fields: [],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 0 },
  hosted: 'allowed',
  validate: () => ({ config: {}, secrets: {} }),
  target: () => null,
});

export function fakeCheckers(results: FakeResults): CheckerMap {
  const list = [
    fakeHttpChecker(results),
    fakeHttpChecker(results, 'fakedocker', 'disabled'),
    { ...fakeHttpChecker(results, 'unavailable'), available: () => false },
    empty('push'),
    empty('group'),
    empty('manual'),
  ];
  return new Map(list.map((c) => [c.type, c as CheckerDefinition<any, any>])); // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A SafeNet that refuses everything (fake checkers never use it). */
export const nullNet: SafeNet = {
  resolve: async () => {
    throw new Error('no network in tests');
  },
  connect: async () => {
    throw new Error('no network in tests');
  },
  request: async () => {
    throw new Error('no network in tests');
  },
  dnsQuery: async () => {
    throw new Error('no network in tests');
  },
  udp: async () => {
    throw new Error('no network in tests');
  },
  assertAllowed: () => {
    throw new Error('no network in tests');
  },
};

/** A trivial secret box (tests only): JSON + base64, still bound to the aad. */
export const fakeSecretBox = {
  seal(data: Record<string, string>, aad: string): Buffer {
    return Buffer.from(JSON.stringify({ aad, data }), 'utf8');
  },
  open(blob: Buffer, aad: string): Record<string, string> {
    const v = JSON.parse(blob.toString('utf8')) as { aad: string; data: Record<string, string> };
    if (v.aad !== aad) throw new Error('aad mismatch');
    return v.data;
  },
};
