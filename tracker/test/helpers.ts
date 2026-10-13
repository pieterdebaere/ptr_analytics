import { JSDOM } from 'jsdom';
import { inject, vi } from 'vitest';

/** The tracker, bundled exactly like build.mjs does (minified IIFE, es2017) — see global-setup.ts. */
export const bundle = inject('bundle');

export const SITE = 'abcdef123456';
export const SCRIPT_SRC = 'https://analytics.example.com/script.js';
export const ENDPOINT = 'https://analytics.example.com/api/event';

/** Captures what the tracker sends (fetch, or the sendBeacon fallback); Blob is replaced so beacon bodies can be read synchronously. */
class FakeBlob {
  constructor(
    public parts: string[],
    public options: { type?: string } = {},
  ) {}
  get type() {
    return this.options.type;
  }
}

export interface Sent {
  transport: 'beacon' | 'fetch';
  url: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  contentType?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  init?: any;
}

export interface LoadOptions {
  url?: string;
  referrer?: string;
  attrs?: Record<string, string>;
  html?: string;
  /** jsdom `pretendToBeVisual` (false = visibilityState "prerender"). Default true. */
  visual?: boolean;
  /** Runs before the tracker is evaluated (install stubs, queue calls, …). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  before?: (win: any) => void;
  /** Don't evaluate the tracker yet. */
  defer?: boolean;
}

export function load(opts: LoadOptions = {}) {
  const attrs = { src: SCRIPT_SRC, 'data-site': SITE, ...opts.attrs };
  const attrHtml = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const dom = new JSDOM(
    `<!doctype html><html><head><script defer ${attrHtml}></script></head><body>${opts.html ?? ''}</body></html>`,
    {
      url: opts.url ?? 'https://example.com/blog/post?utm_source=news&secret=1#top',
      referrer: opts.referrer,
      runScripts: 'outside-only',
      pretendToBeVisual: opts.visual ?? true,
    },
  );
  const win = dom.window;
  const sent: Sent[] = [];
  win.Blob = FakeBlob;
  const beacon = vi.fn((url: string, blob: FakeBlob) => {
    sent.push({ transport: 'beacon', url, body: JSON.parse(blob.parts.join('')), contentType: blob.type });
    return true;
  });
  const fetch = vi.fn((url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ transport: 'fetch', url, body: JSON.parse(init.body), contentType: init.headers['Content-Type'], init });
    return Promise.resolve({ ok: true });
  });
  win.navigator.sendBeacon = beacon;
  win.fetch = fetch;
  // jsdom has no fetch/Request; pretend to be a browser that supports fetch keepalive.
  win.Request = class Request {};
  Object.defineProperty(win.Request.prototype, 'keepalive', { get: () => false });
  opts.before?.(win);
  const run = () => win.eval(bundle);
  if (!opts.defer) run();
  const bodies = () => sent.map((s) => s.body);
  return { win, sent, bodies, beacon, fetch, run };
}

/** Changes document.visibilityState and dispatches visibilitychange. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setVisibility(win: any, state: string) {
  Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => state });
  win.document.dispatchEvent(new win.Event('visibilitychange', { bubbles: true }));
}
