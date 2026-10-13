import { describe, expect, it, vi } from 'vitest';
import { ENDPOINT, SITE, bundle, load, setVisibility } from './helpers';

const URL0 = 'https://example.com/blog/post?utm_source=news&secret=1#top';

describe('initial pageview', () => {
  it('sends one pageview with the documented payload shape via sendBeacon text/plain', () => {
    const { sent, fetch } = load({ referrer: 'https://www.google.com/search?q=x' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.transport).toBe('beacon');
    expect(sent[0]!.url).toBe(ENDPOINT);
    expect(sent[0]!.contentType).toBe('text/plain');
    expect(sent[0]!.body).toEqual({
      site: SITE,
      type: 'pageview',
      url: URL0,
      width: expect.any(Number),
      referrer: 'https://www.google.com/search?q=x',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('omits referrer when there is none', () => {
    const { bodies } = load();
    expect(bodies()[0]).not.toHaveProperty('referrer');
  });

  it('falls back to fetch keepalive without credentials when sendBeacon is missing', () => {
    const { sent, fetch } = load({ before: (w) => (w.navigator.sendBeacon = undefined) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent[0]!.url).toBe(ENDPOINT);
    expect(sent[0]!.init).toMatchObject({
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(sent[0]!.body.type).toBe('pageview');
  });

  it('falls back to fetch when sendBeacon refuses the payload', () => {
    const { fetch, beacon } = load({ before: (w) => (w.navigator.sendBeacon = vi.fn(() => false)) });
    expect(beacon).not.toHaveBeenCalled(); // replaced by the refusing stub
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honours data-endpoint', () => {
    const { sent } = load({ attrs: { 'data-endpoint': 'https://ingest.example.org/api/event' } });
    expect(sent[0]!.url).toBe('https://ingest.example.org/api/event');
  });

  it('works via document.currentScript when executed as a real script element', () => {
    const { win, sent } = load({ defer: true, attrs: { 'data-site': 'zzzzzzzzzzzz' } });
    // A second, inline script tag that is the currently executing one.
    const dom = win.document;
    const s = dom.createElement('script');
    s.setAttribute('data-site', SITE);
    s.setAttribute('data-endpoint', 'https://other.example/api/event');
    Object.defineProperty(dom, 'currentScript', { configurable: true, get: () => s });
    win.eval(bundle);
    expect(sent[0]!.url).toBe('https://other.example/api/event');
    expect(sent[0]!.body.site).toBe(SITE);
  });

  it('does nothing without data-site but still exposes a no-op API', () => {
    const { win, sent } = load({ attrs: { 'data-site': '' } });
    expect(() => win.pa.track('x')).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe('SPA navigation', () => {
  it('sends pageviews on pushState/replaceState/popstate and dedupes identical pathnames', async () => {
    const { win, bodies } = load({ referrer: 'https://google.com/' });
    win.history.pushState({}, '', '/blog/post?page=2'); // same pathname: ignored
    win.history.replaceState({}, '', '/blog/post#section'); // same pathname: ignored
    win.history.pushState({}, '', '/pricing');
    win.history.replaceState({}, '', '/pricing?plan=pro'); // same pathname: ignored
    win.history.pushState({}, '', '/about');
    const urls = bodies().map((b) => b.url);
    expect(urls).toEqual([URL0, 'https://example.com/pricing', 'https://example.com/about']);
    // Referrer only on the first pageview of the page load.
    expect(bodies()[0].referrer).toBe('https://google.com/');
    expect(bodies()[1]).not.toHaveProperty('referrer');

    await new Promise<void>((resolve) => {
      win.addEventListener('popstate', () => setTimeout(resolve, 0));
      win.history.back();
    });
    expect(bodies().map((b) => b.url)).toEqual([
      URL0,
      'https://example.com/pricing',
      'https://example.com/about',
      'https://example.com/pricing?plan=pro',
    ]);
  });

  it('preserves pushState return value and `this`', () => {
    const { win } = load({
      before: (w) => {
        const proto = w.History.prototype;
        const orig = proto.pushState;
        w.history.pushState = function (this: unknown, ...args: unknown[]) {
          orig.apply(this, args);
          return { self: this };
        };
      },
    });
    expect(win.history.pushState({}, '', '/x').self).toBe(win.history);
  });

  it('propagates errors thrown by the original pushState', () => {
    const { win, sent } = load();
    expect(() => win.history.pushState({}, '', 'https://evil.example/')).toThrow();
    expect(sent).toHaveLength(1);
  });

  it('data-auto="false" disables automatic pageviews but pa.pageview() works', () => {
    const { win, bodies } = load({ attrs: { 'data-auto': 'false' } });
    expect(bodies()).toHaveLength(0);
    win.history.pushState({}, '', '/next');
    expect(bodies()).toHaveLength(0);
    win.pa.pageview();
    expect(bodies()).toEqual([{ site: SITE, type: 'pageview', url: 'https://example.com/next', width: expect.any(Number) }]);
  });
});

describe('pa.pageview(path)', () => {
  it('builds the URL on the current origin', () => {
    const { win, bodies } = load({ attrs: { 'data-auto': 'false' } });
    win.pa.pageview('/virtual/path?utm_campaign=c');
    expect(bodies()[0].url).toBe('https://example.com/virtual/path?utm_campaign=c');
  });

  it.each([['//evil.com/x'], ['/\\evil.com'], ['https://evil.com/'], ['relative'], [''], [42], [{}]])(
    'rejects %j',
    (path) => {
      const warn = vi.fn();
      const { win, bodies } = load({
        attrs: { 'data-auto': 'false', 'data-debug': 'true' },
        before: (w) => (w.console.warn = warn),
      });
      win.pa.pageview(path);
      expect(bodies()).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    },
  );
});

describe('skipping', () => {
  it('excludes paths matching data-exclude globs (pageviews and events)', () => {
    const { win, bodies } = load({
      url: 'https://example.com/admin/users/1',
      attrs: { 'data-exclude': '/admin/**, /preview/*' },
    });
    win.pa.track('Click');
    expect(bodies()).toHaveLength(0);
    win.history.pushState({}, '', '/preview/abc');
    win.history.pushState({}, '', '/preview/abc/def');
    win.history.pushState({}, '', '/admin');
    win.history.pushState({}, '', '/public');
    expect(bodies().map((b) => b.url)).toEqual(['https://example.com/preview/abc/def', 'https://example.com/public']);
  });

  it.each(['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://app.localhost/'])(
    'skips %s by default',
    (url) => {
      const { win, sent } = load({ url });
      win.pa.track('x');
      expect(sent).toHaveLength(0);
    },
  );

  it('tracks localhost with data-allow-localhost="true"', () => {
    const { bodies } = load({ url: 'http://localhost:3000/', attrs: { 'data-allow-localhost': 'true' } });
    expect(bodies()[0].url).toBe('http://localhost:3000/');
  });

  it('ignores DNT unless data-respect-dnt="true"', () => {
    const dnt = (w: { navigator: object }) => Object.defineProperty(w.navigator, 'doNotTrack', { value: '1' });
    expect(load({ before: dnt }).sent).toHaveLength(1);
    expect(load({ before: dnt, attrs: { 'data-respect-dnt': 'true' } }).sent).toHaveLength(0);
  });

  it('respects Global Privacy Control when data-respect-dnt="true"', () => {
    const gpc = (w: { navigator: object }) =>
      Object.defineProperty(w.navigator, 'globalPrivacyControl', { value: true });
    expect(load({ before: gpc, attrs: { 'data-respect-dnt': 'true' } }).sent).toHaveLength(0);
  });

  it('skips automation (navigator.webdriver)', () => {
    const { sent } = load({ before: (w) => Object.defineProperty(w.navigator, 'webdriver', { value: true }) });
    expect(sent).toHaveLength(0);
  });

  it('respects the pa_ignore opt-out flag, also when set after load', () => {
    expect(load({ before: (w) => w.localStorage.setItem('pa_ignore', 'true') }).sent).toHaveLength(0);

    const { win, sent } = load();
    expect(sent).toHaveLength(1);
    win.localStorage.setItem('pa_ignore', 'true');
    win.pa.track('x');
    win.history.pushState({}, '', '/other');
    expect(sent).toHaveLength(1);
  });

  it('survives localStorage throwing', () => {
    const { sent } = load({
      before: (w) =>
        Object.defineProperty(w, 'localStorage', {
          get() {
            throw new Error('SecurityError');
          },
        }),
    });
    expect(sent).toHaveLength(1);
  });

  it('waits for a prerendered page to become visible', () => {
    const { win, bodies } = load({ visual: false });
    expect(win.document.visibilityState).toBe('prerender');
    win.pa.track('During prerender');
    expect(bodies()).toHaveLength(0);
    setVisibility(win, 'visible');
    expect(bodies().map((b) => b.type)).toEqual(['pageview', 'event']);
    setVisibility(win, 'hidden');
    setVisibility(win, 'visible');
    expect(bodies()).toHaveLength(2);
  });
});

describe('custom events', () => {
  it('pa.track sends name + props', () => {
    const { win, bodies } = load();
    win.pa.track('Signup', { plan: 'pro', seats: 3 });
    win.pa.track('  Plain  ');
    expect(bodies()[1]).toEqual({
      site: SITE,
      type: 'event',
      url: URL0,
      width: expect.any(Number),
      name: 'Signup',
      props: { plan: 'pro', seats: 3 },
    });
    expect(bodies()[2]).toEqual({ site: SITE, type: 'event', url: URL0, width: expect.any(Number), name: 'Plain' });
    expect(bodies()[1]).not.toHaveProperty('referrer');
  });

  it('pa("track", …) dispatches like pa.track', () => {
    const { win, bodies } = load();
    win.pa('track', 'Signup', { plan: 'pro' });
    win.pa('pageview', '/v');
    expect(bodies().slice(1).map((b) => [b.type, b.name, b.url])).toEqual([
      ['event', 'Signup', URL0],
      ['pageview', undefined, 'https://example.com/v'],
    ]);
  });

  it.each([[''], ['   '], ['x'.repeat(101)], [42], [null]])('drops invalid name %j (warns only in debug)', (name) => {
    const warn = vi.fn();
    const quiet = load({ before: (w) => (w.console.warn = warn) });
    quiet.win.pa.track(name);
    expect(quiet.sent).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    const debug = load({ attrs: { 'data-debug': 'true' }, before: (w) => (w.console.warn = warn) });
    debug.win.pa.track(name);
    expect(debug.sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([['str'], [[1, 2]], [new Date(0)], [5]])('drops non-plain props %j', (props) => {
    const { win, sent } = load();
    win.pa.track('E', props);
    expect(sent).toHaveLength(1);
  });

  it('accepts a 100-char name and null-prototype props', () => {
    const { win, bodies } = load();
    const props = Object.assign(Object.create(null), { a: 1 });
    win.pa.track('n'.repeat(100), props);
    expect(bodies()[1].props).toEqual({ a: 1 });
  });
});

describe('queue replay', () => {
  it('replays calls queued with the documented snippet, in order, after the pageview', () => {
    const { win, bodies } = load({
      before: (w) => {
        w.eval('window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)}');
        w.pa('track', 'Early', { a: 1 });
        w.pa('pageview', '/virtual');
        w.pa('bogus');
        w.pa.beforeSend = (e: { url: string }) => ({ ...e, url: e.url.replace(/\?.*$/, '') });
      },
    });
    expect(bodies().map((b) => [b.type, b.name, b.url])).toEqual([
      ['pageview', undefined, 'https://example.com/blog/post'],
      ['event', 'Early', 'https://example.com/blog/post'],
      ['pageview', undefined, 'https://example.com/virtual'],
    ]);
    expect(typeof win.pa.track).toBe('function');
    expect(win.pa.q).toBeUndefined();
  });
});

describe('beforeSend', () => {
  it('can modify the payload', () => {
    const { win, bodies } = load();
    win.pa.beforeSend = (e: { url: string; props?: object }) => ({ ...e, url: 'https://example.com/redacted' });
    win.pa.track('E', { a: 1 });
    expect(bodies()[1]).toMatchObject({ url: 'https://example.com/redacted', name: 'E', props: { a: 1 } });
  });

  it('receives the full payload', () => {
    const { win } = load();
    const hook = vi.fn((e: unknown) => e);
    win.pa.beforeSend = hook;
    win.pa.track('E', { a: 1 });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ site: SITE, type: 'event', url: URL0, name: 'E', props: { a: 1 } }),
    );
  });

  it.each([[null], [false], [undefined], ['string']])('drops the event when it returns %j', (ret) => {
    const { win, sent } = load();
    win.pa.beforeSend = () => ret;
    win.pa.track('E');
    win.history.pushState({}, '', '/next');
    expect(sent).toHaveLength(1);
  });

  it('drops the event (fail closed) and does not throw when the hook throws', () => {
    const { win, sent } = load();
    win.pa.beforeSend = () => {
      throw new Error('boom');
    };
    expect(() => win.pa.track('E')).not.toThrow();
    expect(() => win.history.pushState({}, '', '/next')).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});

describe('declarative events', () => {
  it('sends an event for clicks on [data-pa-event] or its descendants, with lower-cased props', () => {
    const { win, bodies } = load({
      html: `<button data-pa-event="Signup" data-pa-event-plan="pro" data-pa-event-Seats="3" data-pa-event-="x"><span id="inner">Go</span></button>
             <a id="plain" href="#">plain</a>
             <div data-pa-event="Bare"><i id="bare">b</i></div>`,
    });
    win.document.getElementById('inner').click();
    win.document.getElementById('plain').click();
    win.document.getElementById('bare').click();
    expect(bodies().slice(1)).toEqual([
      { site: SITE, type: 'event', url: URL0, width: expect.any(Number), name: 'Signup', props: { plan: 'pro', seats: '3' } },
      { site: SITE, type: 'event', url: URL0, width: expect.any(Number), name: 'Bare' },
    ]);
  });

  it('still tracks when the page stops propagation', () => {
    const { win, bodies } = load({ html: `<button id="b" data-pa-event="X">x</button>` });
    win.document.getElementById('b').addEventListener('click', (e: Event) => e.stopPropagation());
    win.document.getElementById('b').click();
    expect(bodies()[1].name).toBe('X');
  });
});

describe('double include', () => {
  it('a second copy of the script does nothing', () => {
    const { win, bodies } = load();
    const first = win.pa;
    win.eval(bundle);
    expect(win.pa).toBe(first);
    win.history.pushState({}, '', '/next');
    win.document.body.innerHTML = '<b id="b" data-pa-event="X">x</b>';
    win.document.getElementById('b').click();
    expect(bodies().map((b) => b.type)).toEqual(['pageview', 'pageview', 'event']);
  });
});

describe('privacy & hygiene', () => {
  it('writes no cookies or storage and leaks no globals besides window.pa', () => {
    const cookieSet = vi.fn();
    let keysBefore: string[] = [];
    const { win } = load({
      defer: true,
      html: '<button id="b" data-pa-event="X">x</button>',
    });
    Object.defineProperty(win.document, 'cookie', { configurable: true, get: () => '', set: cookieSet });
    const setItem = vi.spyOn(win.Storage.prototype, 'setItem');
    keysBefore = Object.getOwnPropertyNames(win);
    win.eval(bundle);
    win.pa.track('E', { a: 1 });
    win.history.pushState({}, '', '/next');
    win.document.getElementById('b').click();
    setVisibility(win, 'hidden');
    win.dispatchEvent(new win.Event('pagehide'));
    expect(cookieSet).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(win.localStorage.length).toBe(0);
    expect(win.sessionStorage.length).toBe(0);
    expect(Object.getOwnPropertyNames(win).filter((k) => !keysBefore.includes(k))).toEqual(['pa']);
  });

  it('never throws into the page when browser APIs are missing', () => {
    expect(() =>
      load({
        before: (w) => {
          w.URL = undefined;
          w.navigator.sendBeacon = undefined;
          w.fetch = undefined;
        },
      }),
    ).not.toThrow();
  });
});

describe('vitals integration', () => {
  type Cb = (list: { getEntries: () => unknown[] }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function installFakePerf(w: any) {
    const observers: Record<string, { cb: Cb; off?: boolean; init?: object }> = {};
    w.PerformanceObserver = class {
      static supportedEntryTypes = ['paint', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input'];
      o: { cb: Cb; off?: boolean; init?: object };
      constructor(cb: Cb) {
        this.o = { cb };
      }
      observe(init: { type: string; buffered: boolean }) {
        expect(init.buffered).toBe(true);
        this.o.init = init;
        observers[init.type] = this.o;
      }
      takeRecords() {
        return [];
      }
      disconnect() {
        this.o.off = true;
      }
    };
    w.performance.getEntriesByType = (t: string) => (t === 'navigation' ? [{ responseStart: 120.4, activationStart: 0 }] : []);
    w.performance.now = () => 60_000;
    const emit = (type: string, entries: unknown[]) => {
      const o = observers[type]!;
      if (!o.off) o.cb({ getEntries: () => entries });
    };
    return { observers, emit };
  }

  function loadWithVitals(attrs: Record<string, string> = {}, url?: string) {
    let fake!: ReturnType<typeof installFakePerf>;
    const ctx = load({ attrs, url, before: (w) => (fake = installFakePerf(w)) });
    return { ...ctx, fake };
  }

  it('observes with buffered: true and durationThreshold 40 for event timing', () => {
    const { fake } = loadWithVitals();
    expect(Object.keys(fake.observers).sort()).toEqual(
      ['event', 'first-input', 'largest-contentful-paint', 'layout-shift', 'paint'],
    );
    expect(fake.observers.event!.init).toMatchObject({ type: 'event', buffered: true, durationThreshold: 40 });
  });

  it('sends one vitals payload on first hidden, attributed to the initial URL', () => {
    const { win, bodies, fake } = loadWithVitals();
    fake.emit('paint', [{ name: 'first-paint', startTime: 80 }, { name: 'first-contentful-paint', startTime: 150.6 }]);
    fake.emit('largest-contentful-paint', [{ startTime: 400 }, { startTime: 1234.4 }]);
    fake.emit('layout-shift', [
      { startTime: 1000, value: 0.05, hadRecentInput: false },
      { startTime: 1500, value: 0.05, hadRecentInput: true },
      { startTime: 1600, value: 0.02, hadRecentInput: false },
    ]);
    fake.emit('event', [
      { interactionId: 1, duration: 56, startTime: 3000 },
      { interactionId: 1, duration: 120, startTime: 3000 },
      { interactionId: 0, duration: 900, startTime: 3100 },
      { interactionId: 2, duration: 72, startTime: 4000 },
    ]);
    win.history.pushState({}, '', '/next-page');
    setVisibility(win, 'hidden');
    win.dispatchEvent(new win.Event('pagehide'));
    setVisibility(win, 'visible');
    setVisibility(win, 'hidden');
    const vitals = bodies().filter((b) => b.type === 'vitals');
    expect(vitals).toEqual([
      {
        site: SITE,
        type: 'vitals',
        url: URL0,
        width: expect.any(Number),
        metrics: [
          { name: 'TTFB', value: 120 },
          { name: 'FCP', value: 151 },
          { name: 'LCP', value: 1234 },
          { name: 'CLS', value: 0.07 },
          { name: 'INP', value: 120 },
        ],
      },
    ]);
  });

  it('only includes metrics that have a value, and sends nothing when there are none', () => {
    const { win, bodies, fake } = loadWithVitals();
    win.performance.getEntriesByType = () => [];
    fake.emit('largest-contentful-paint', [{ startTime: 900 }]);
    setVisibility(win, 'hidden');
    expect(bodies().filter((b) => b.type === 'vitals')[0].metrics).toEqual([{ name: 'LCP', value: 900 }]);

    const empty = loadWithVitals();
    empty.win.performance.getEntriesByType = () => [];
    empty.win.dispatchEvent(new empty.win.Event('pagehide'));
    expect(empty.bodies().filter((b) => b.type === 'vitals')).toHaveLength(0);
  });

  it('finalises LCP on first input', () => {
    const { win, bodies, fake } = loadWithVitals();
    fake.emit('largest-contentful-paint', [{ startTime: 500 }]);
    win.dispatchEvent(new win.Event('keydown'));
    fake.emit('largest-contentful-paint', [{ startTime: 2500 }]); // late entry from a still-running observer
    setVisibility(win, 'hidden');
    const m = bodies().find((b) => b.type === 'vitals').metrics;
    expect(m.find((x: { name: string }) => x.name === 'LCP').value).toBe(500);
  });

  it('respects data-vitals="false", data-vitals-sample and exclusions', () => {
    for (const [attrs, url] of [
      [{ 'data-vitals': 'false' }, undefined],
      [{ 'data-vitals-sample': '0' }, undefined],
      [{ 'data-exclude': '/blog/**' }, undefined],
    ] as const) {
      const { win, bodies } = loadWithVitals(attrs, url);
      setVisibility(win, 'hidden');
      expect(bodies().filter((b) => b.type === 'vitals')).toHaveLength(0);
    }
  });

  it('applies the sample rate with Math.random', () => {
    const { win, bodies } = load({
      attrs: { 'data-vitals-sample': '0.5' },
      before: (w) => {
        installFakePerf(w);
        w.Math.random = () => 0.49;
      },
    });
    setVisibility(win, 'hidden');
    expect(bodies().filter((b) => b.type === 'vitals')).toHaveLength(1);
  });

  it('is not sent when opted out after load', () => {
    const { win, bodies } = loadWithVitals();
    win.localStorage.setItem('pa_ignore', 'true');
    setVisibility(win, 'hidden');
    expect(bodies().filter((b) => b.type === 'vitals')).toHaveLength(0);
  });
});
