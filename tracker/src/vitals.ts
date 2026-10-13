// Web vitals (Speed Insights) collection: LCP, FCP, CLS, INP, TTFB.
// A small, dependency-free re-implementation of the semantics of Google's
// `web-vitals` library, reduced to "report once when the page is first hidden".

export interface Metric {
  name: 'LCP' | 'FCP' | 'CLS' | 'INP' | 'TTFB';
  value: number;
}

/** The subset of PerformanceEntry fields we read (covers paint, LCP, layout-shift, event timing). */
export interface Entry {
  name?: string;
  startTime: number;
  duration?: number;
  value?: number;
  hadRecentInput?: boolean;
  interactionId?: number;
}

/**
 * CLS = largest "session window" of layout shifts: shifts less than 1 s apart, a window
 * spanning at most 5 s. Shifts within 500 ms of user input are ignored.
 * Returns a function that adds one layout-shift entry and returns the current CLS.
 */
export function clsTracker(): (e: Entry) => number {
  let max = 0;
  let cur = 0;
  let first = 0;
  let last = 0;
  return (e) => {
    if (!e.hadRecentInput) {
      const v = e.value || 0;
      if (cur && e.startTime - last < 1000 && e.startTime - first < 5000) cur += v;
      else {
        cur = v;
        first = e.startTime;
      }
      last = e.startTime;
      if (cur > max) max = cur;
    }
    return max;
  };
}

/**
 * INP ≈ p98 of interaction latencies. An interaction's latency is the longest event-timing
 * duration sharing its interactionId; sorted descending, we pick the entry at index
 * floor(interactionCount / 50), i.e. ignore one outlier per 50 interactions (as web-vitals).
 */
export function inpTracker(): { add: (e: Entry) => void; value: (count?: number) => number | undefined } {
  const byId: Record<number, number> = {};
  return {
    add(e) {
      const id = e.interactionId;
      if (id) byId[id] = Math.max(byId[id] || 0, e.duration || 0);
    },
    value(count) {
      const all = Object.values(byId).sort((a, b) => b - a);
      return all[Math.min(all.length - 1, Math.floor(Math.max(count || 0, all.length) / 50))];
    },
  };
}

/** Rounds and range-checks a metric value; returns undefined when it must not be sent. */
export function clean(name: Metric['name'], v: number | undefined): number | undefined {
  return v! >= 0 && v! <= (name == 'CLS' ? 100 : 6e5) ? (name == 'CLS' ? Math.round(v! * 1e4) / 1e4 : Math.round(v!)) : undefined;
}

type Nav = { responseStart: number; activationStart?: number };

/**
 * Starts observing. Returns `collect()`, to be called once when the page is hidden: it
 * drains pending entries, stops observing and returns the metrics that have a value.
 */
export function observeVitals(): () => Metric[] {
  const perf = performance;
  const nav = () => perf.getEntriesByType('navigation')[0] as unknown as Nav | undefined;
  const n0 = nav();
  const act = (n0 && n0.activationStart) || 0;
  // FCP/LCP are only meaningful if the page was visible the whole time before them.
  const hiddenAt = document.visibilityState == 'hidden' ? 0 : Infinity;
  const rel = (t: number) => Math.max(t - act, 0);
  const drains: (() => void)[] = [];
  const addCls = clsTracker();
  const inp = inpTracker();
  let fcp: number | undefined;
  let lcp: number | undefined;
  let cls: number | undefined;

  // Feature-detected PerformanceObserver; returns a function that drains pending
  // records and disconnects (undefined when the entry type is unsupported).
  const observe = (type: string, cb: (e: Entry) => void, durationThreshold?: number) => {
    try {
      if (PerformanceObserver.supportedEntryTypes.indexOf(type) > -1) {
        const po = new PerformanceObserver((l) => l.getEntries().forEach(cb as (e: PerformanceEntry) => void));
        po.observe({ type, buffered: true, durationThreshold } as PerformanceObserverInit);
        const drain = () => {
          (po.takeRecords() as Entry[]).forEach(cb);
          po.disconnect();
        };
        drains.push(drain);
        return drain;
      }
    } catch {
      // unsupported browser / entry type / option
    }
    return undefined;
  };

  observe('paint', (e) => {
    if (e.name == 'first-contentful-paint' && e.startTime < hiddenAt) fcp = rel(e.startTime);
  });
  const stopLcp = observe('largest-contentful-paint', (e) => {
    if (e.startTime < hiddenAt) lcp = rel(e.startTime);
  });
  // LCP is final after the first user input.
  if (stopLcp) ['keydown', 'click'].forEach((t) => addEventListener(t, stopLcp, { once: true, capture: true }));
  if (observe('layout-shift', (e) => (cls = addCls(e)))) cls = 0;
  observe('event', inp.add, 40);
  observe('first-input', inp.add);

  return () => {
    drains.forEach((f) => {
      try {
        f();
      } catch {
        // ignore
      }
    });
    const out: Metric[] = [];
    const put = (name: Metric['name'], v: number | undefined) => {
      const c = clean(name, v);
      if (c != null) out.push({ name, value: c });
    };
    const n = nav();
    if (n && n.responseStart > 0 && n.responseStart <= perf.now()) put('TTFB', rel(n.responseStart));
    put('FCP', fcp);
    put('LCP', lcp);
    // web-vitals only reports CLS once the page has painted.
    if (fcp != null) put('CLS', cls);
    put('INP', inp.value((perf as unknown as { interactionCount?: number }).interactionCount));
    return out;
  };
}
