// PTR Analytics tracker. See ../README.md and docs/SPEC.md section 3.
// Privacy: never writes cookies or storage; only reads localStorage.pa_ignore.
import { globMatcher } from './glob';
import { observeVitals, type Metric } from './vitals';

export interface Payload {
  site: string;
  type: 'pageview' | 'event' | 'vitals';
  url: string;
  width?: number;
  referrer?: string;
  name?: string;
  props?: Record<string, unknown>;
  metrics?: Metric[];
}

type BeforeSend = (p: Payload) => Payload | null | false | undefined;

interface Api {
  (...args: unknown[]): void;
  track: (name: string, props?: Record<string, unknown>) => void;
  pageview: (path?: string) => void;
  beforeSend?: BeforeSend;
  q?: ArrayLike<unknown>[];
  _ptr?: 1;
}

const noop = () => {};
const on = (t: EventTarget, type: string, f: EventListener, capture?: boolean) => t.addEventListener(type, f, capture);

function main() {
  const w = window as unknown as Window & { pa?: Api };
  const d = document;
  const n = navigator as Navigator & { globalPrivacyControl?: boolean };
  const loc = location;
  const prev = w.pa;

  // Included twice: the first instance already owns window.pa.
  if (prev && prev._ptr) return;

  // Fallback (currentScript is null in some loaders): only a tag that actually loads the tracker,
  // so an inert injected `<script data-site>` cannot redirect the data.
  const script = (d.currentScript || d.querySelector('script[data-site][src$="/script.js"]')) as HTMLScriptElement | null;
  const attr = (k: string) => (script && script.getAttribute('data-' + k)) || '';
  const is = (k: string, v: string) => attr(k) === v;
  const warn = (m: string) => {
    if (is('debug', 'true')) console.warn('[pa] ' + m);
  };
  const site = attr('site');
  const endpoint = attr('endpoint') || (script && script.src ? new URL(script.src).origin : '') + '/api/event';
  // At most 20 globs of up to 200 characters each (matching is linear-time anyway).
  const exclude = attr('exclude')
    .split(',')
    .filter((g) => g.trim() && g.length <= 200)
    .slice(0, 20)
    .map(globMatcher);
  const sample = +(attr('vitals-sample') || 1);
  const optedOut = () => {
    try {
      return localStorage.getItem('pa_ignore') == 'true';
    } catch {
      return false;
    }
  };

  const off = !site
    ? 'no data-site'
    : n.webdriver
      ? 'webdriver'
      : !is('allow-localhost', 'true') &&
          (/(^|\.)localhost$|^127\.|^\[::1\]$/.test(loc.hostname) || loc.protocol == 'file:')
        ? 'localhost'
        : is('respect-dnt', 'true') && (n.doNotTrack == '1' || n.globalPrivacyControl)
          ? 'DNT'
          : optedOut()
            ? 'pa_ignore'
            : '';
  if (off) warn('off: ' + off);

  let ready = false;
  let lastPath: string | undefined;
  let referrer = d.referrer;
  const queue: ArrayLike<unknown>[] = prev && prev.q ? [].slice.call(prev.q) : [];

  const base = (u: URL) => u.protocol + '//' + u.host;

  const send = (type: Payload['type'], url: string, path: string, extra: Partial<Payload>) => {
    if (off || optedOut() || exclude.some((m) => m(path))) return;
    let p: ReturnType<BeforeSend> = Object.assign({ site, type, url, width: w.innerWidth }, extra);
    const hook = api.beforeSend;
    if (typeof hook == 'function') {
      try {
        p = hook(p!);
      } catch (e) {
        // Fail closed: the hook may exist to redact data.
        return warn('beforeSend: ' + e);
      }
      if (!p || typeof p != 'object') return;
    }
    // Data minimisation, applied to whatever beforeSend returned: the url keeps only origin,
    // path and the utm_* parameters the server uses (never the fragment); the referrer only
    // its origin, and only when it is another http(s) origin.
    let body: string;
    try {
      const u = new URL(p.url);
      const q = u.search
        .slice(1)
        .split('&')
        .filter((s) => /^utm_(source|medium|campaign|term|content)=/.test(s))
        .join('&');
      const r = p.referrer && new URL(p.referrer);
      const ref = r && /^https?:$/.test(r.protocol) && base(r);
      body = JSON.stringify(
        Object.assign({}, p, {
          url: base(u) + u.pathname + (q && '?' + q),
          referrer: ref && ref != base(u) && ref != loc.origin ? ref + '/' : undefined,
        }),
      );
    } catch (e) {
      return warn('bad url: ' + e);
    }
    // fetch keepalive survives page unload and, unlike sendBeacon, can omit credentials.
    // text/plain without custom headers is a CORS-simple request: no preflight.
    try {
      if ('keepalive' in Request.prototype)
        return void fetch(endpoint, {
          method: 'POST',
          body,
          keepalive: true,
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' },
        }).catch(noop);
    } catch {
      // no fetch / Request: fall through to sendBeacon
    }
    try {
      n.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }));
    } catch {
      // no transport available
    }
  };

  const pageview = (path?: unknown, auto?: boolean) => {
    let u: URL | false = new URL(loc.href);
    if (path != null) {
      u = typeof path == 'string' && /^\/(?![/\\])[^\\]*$/.test(path) && new URL(path, u);
      if (!u || u.origin != loc.origin) return warn('bad path: ' + path);
    }
    if (auto && u.pathname == lastPath) return;
    lastPath = u.pathname;
    // Referrer only for the first pageview of the page load.
    send('pageview', u.href, u.pathname, referrer ? { referrer } : {});
    referrer = '';
  };

  const track = (name: unknown, props?: unknown) => {
    if (typeof name != 'string' || !(name = name.trim()) || (name as string).length > 100) return warn('bad name');
    // Realm-independent "plain object" check (rejects arrays, dates, strings, …).
    if (props != null && {}.toString.call(props) != '[object Object]') return warn('bad props');
    send('event', loc.href, loc.pathname, { name: name as string, props: props as Payload['props'] });
  };

  const run = (a: ArrayLike<unknown>) => {
    try {
      if (a[0] == 'track') track(a[1], a[2]);
      else if (a[0] == 'pageview') pageview(a[1]);
    } catch (e) {
      warn('' + e);
    }
  };

  const api = function () {
    // eslint-disable-next-line prefer-rest-params
    ready ? run(arguments) : queue.push(arguments);
  } as Api;
  api.track = (name, props) => api('track', name, props);
  api.pageview = (path) => api('pageview', path);
  if (prev) api.beforeSend = prev.beforeSend;
  api._ptr = 1;
  w.pa = api;

  const start = () => {
    // Prerendered pages: wait until the page is actually shown.
    if (ready || (d as Document & { prerendering?: boolean }).prerendering || (d.visibilityState as string) == 'prerender')
      return;
    ready = true;
    if (!off)
      try {
        if (!is('auto', 'false')) {
          const nav = () => {
            try {
              pageview(null, true);
            } catch {
              // never break the host's navigation
            }
          };
          const h = history as History & Record<string, unknown>;
          ['pushState', 'replaceState'].forEach((k) => {
            const orig = h[k];
            if (typeof orig == 'function')
              h[k] = function (this: History) {
                // eslint-disable-next-line prefer-rest-params
                const r = orig.apply(this, arguments);
                nav();
                return r;
              };
          });
          on(w, 'popstate', nav);
          nav();
        }

        on(
          d,
          'click',
          (e) => {
            try {
              const el = (e.target as Element).closest('[data-pa-event]');
              if (!el) return;
              let props: Record<string, string> | undefined;
              for (let i = 0, a; (a = el.attributes[i]); i++) {
                const m = /^data-pa-event-(.+)/i.exec(a.name);
                if (m) (props = props || {})[m[1]!.toLowerCase()] = a.value;
              }
              track(el.getAttribute('data-pa-event'), props);
            } catch {
              // ignore
            }
          },
          true,
        );

        if (!is('vitals', 'false') && Math.random() < (sample >= 0 ? sample : 1)) {
          const collect = observeVitals();
          const url = loc.href;
          const path = loc.pathname;
          let done = 0;
          const flush = () => {
            try {
              if (!done++) {
                const metrics = collect();
                if (metrics.length) send('vitals', url, path, { metrics });
              }
            } catch {
              // ignore
            }
          };
          on(d, 'visibilitychange', () => d.visibilityState == 'hidden' && flush());
          on(w, 'pagehide', flush);
        }
      } catch {
        // ignore
      }
    queue.splice(0).forEach(run);
  };

  ['visibilitychange', 'prerenderingchange'].forEach((t) => on(d, t, start));
  start();
}

try {
  main();
} catch {
  // Never throw into the host page.
}
