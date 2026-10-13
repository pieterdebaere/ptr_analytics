// Live views: globe, live counter, visitors-per-minute line, recent pageviews feed.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActivityIcon, GlobeIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { LiveCountry, LiveOverviewResponse, LiveRecentPageview, SiteLiveResponse } from '@/api/types';
import { LazyGlobe as Globe } from './LazyGlobe';
import { LiveLine } from '@/components/charts/live-line';
import { LiveLineChart } from '@/components/charts/live-line-chart';
import { LiveXAxis } from '@/components/charts/live-x-axis';
import { Grid } from '@/components/charts/grid';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageVisible } from '@/hooks/usePageVisible';
import { usePolling } from '@/hooks/usePolling';
import { countryName, flagEmoji } from '@/lib/countries';
import { formatNumber } from '@/lib/format';
import {
  LIVE_POLL_MS,
  LIVE_WINDOW_SECONDS,
  appendSample,
  diffRecent,
  globeCountries,
  isoCountry,
  mergePings,
  relativeTime,
  type LiveSample,
  type Ping,
} from '@/lib/live';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, LiveDot } from './common';

/* ---------------- Data hooks ---------------- */

export interface SiteLiveState {
  data: SiteLiveResponse | undefined;
  error: string | null;
  series: LiveSample[];
  pings: Ping[];
  /** client time of the last successful poll (ms) */
  now: number;
}

/** Polls GET /api/sites/:id/stats/live every 5 s while the page is visible. */
export function useSiteLive(siteId: string): SiteLiveState {
  const seen = useRef<Set<string>>(new Set());
  const [series, setSeries] = useState<LiveSample[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const onData = useCallback((d: SiteLiveResponse) => {
    const t = Date.now();
    setNow(t);
    const visitors = typeof d?.visitors === 'number' && Number.isFinite(d.visitors) ? d.visitors : 0;
    setSeries((s) => appendSample(s, { time: t / 1000, value: visitors }, LIVE_WINDOW_SECONDS));
    const diff = diffRecent(seen.current, Array.isArray(d?.recent) ? d.recent : [], t);
    seen.current = diff.seen;
    if (diff.pings.length) setPings((p) => mergePings(p, diff.pings));
  }, []);

  // Callers key the component by site id, so state never leaks between sites.
  const { data, error } = usePolling((signal) => api.siteLive(siteId, signal), LIVE_POLL_MS, [siteId], onData);
  return { data, error, series, pings, now };
}

/** Polls GET /api/live (all accessible sites) every 10 s while visible. */
export function useLiveOverview(): { data: LiveOverviewResponse | undefined; error: string | null; unavailable: boolean } {
  const { data, error, errorStatus } = usePolling((signal) => api.live(signal), 10_000, []);
  return { data, error, unavailable: errorStatus === 404 };
}

/* ---------------- Pieces ---------------- */

export function LiveCounter({ visitors, label = 'online now', className }: { visitors: number | null; label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)} aria-live="polite">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <LiveDot active={!!visitors} />
        Live
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-semibold tracking-tight tabular-nums">{visitors === null ? '–' : formatNumber(visitors)}</span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

function CountryLabel({ code }: { code: string | null }) {
  const iso = isoCountry(code);
  const flag = iso ? flagEmoji(iso) : '';
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="w-5 shrink-0 text-center text-base leading-none" aria-hidden="true">
        {flag || '🌐'}
      </span>
      <span className={cn('bidi-isolate truncate', !iso && 'text-muted-foreground')}>{displayText(countryName(iso ?? code ?? null))}</span>
    </span>
  );
}

/** Top countries with relative bars. */
export function LiveCountryList({ countries, limit = 6 }: { countries: readonly LiveCountry[]; limit?: number }) {
  const rows = [...countries].filter((c) => typeof c.visitors === 'number').sort((a, b) => b.visitors - a.visitors).slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No visitors right now.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <li key={`${r.country ?? 'null'}-${i}`} className="relative flex h-8 items-center justify-between gap-3 rounded-md px-2 text-sm">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 rounded-md bg-chart-1/12 dark:bg-chart-1/18" style={{ width: `${(r.visitors / max) * 100}%` }} />
          <span className="relative min-w-0">
            <CountryLabel code={r.country} />
          </span>
          <span className="relative font-medium tabular-nums">{formatNumber(r.visitors)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Newest pageviews first; paths are untrusted and rendered as isolated text. */
export function LiveFeed({ recent, now, className }: { recent: readonly LiveRecentPageview[]; now: number; className?: string }) {
  if (recent.length === 0) {
    return (
      <EmptyState title="Waiting for pageviews" icon={<ActivityIcon />} className={className}>
        <p>New pageviews appear here within seconds.</p>
      </EmptyState>
    );
  }
  return (
    <ol className={cn('flex flex-col', className)} aria-label="Recent pageviews">
      {recent.map((r, i) => {
        const iso = isoCountry(r.country);
        const flag = iso ? flagEmoji(iso) : '';
        return (
          <li key={`${r.ts}-${i}`} className="flex h-9 items-center gap-3 border-b px-1 text-sm last:border-b-0">
            <span className="w-5 shrink-0 text-center text-base leading-none" title={iso ? countryName(iso) : 'Unknown location'}>
              <span aria-hidden="true">{flag || '🌐'}</span>
              <span className="sr-only">{iso ? countryName(iso) : 'Unknown location'}</span>
            </span>
            <bdi className="bidi-isolate min-w-0 flex-1 truncate font-mono text-[13px]" title={displayText(r.path)}>
              {displayText(r.path)}
            </bdi>
            <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={new Date(r.ts).toISOString()}>
              {relativeTime(r.ts, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

const hhmm = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Bklit live line of the visitor count, accumulated client-side from the polls. */
export function LiveVisitorsChart({ series, value }: { series: readonly LiveSample[]; value: number }) {
  const visible = usePageVisible();
  const data = useMemo(() => [...series], [series]);
  return (
    <LiveLineChart
      data={data}
      value={value}
      window={LIVE_WINDOW_SECONDS}
      numXTicks={6}
      paused={!visible}
      margin={{ top: 20, right: 56, bottom: 30, left: 8 }}
      style={{ height: 220, touchAction: 'pan-y' }}
    >
      <Grid horizontal numTicksRows={3} strokeDasharray="3,4" fadeHorizontal={false} />
      <LiveLine dataKey="value" formatValue={(v) => formatNumber(Math.max(0, Math.round(v)))} />
      <LiveXAxis numTicks={6} formatTime={(t) => hhmm.format(new Date(t))} />
    </LiveLineChart>
  );
}

/* ---------------- Overview card (all sites) ---------------- */

export function LiveOverviewCard({ siteHref }: { siteHref: (id: string) => string }) {
  const { data, error, unavailable } = useLiveOverview();
  const countries = useMemo(() => globeCountries(data?.countries), [data]);
  if (unavailable) return null;
  const sites = [...(data?.sites ?? [])].filter((s) => s.visitors > 0).sort((a, b) => b.visitors - a.visitors).slice(0, 5);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative border-b lg:border-r lg:border-b-0">
          <Globe countries={countries} valueLabel="visitors" scrollZoom={false} formatValue={formatNumber} className="h-72 w-full sm:h-80 lg:h-[22rem]">
            <div className="pointer-events-none absolute top-4 left-4">
              <LiveCounter visitors={data ? data.visitors : null} label="visitors online" />
            </div>
          </Globe>
        </div>
        <div className="flex flex-col gap-4 p-4">
          {error && !data ? <ErrorState message={error} /> : null}
          <div>
            <h2 className="mb-2 text-sm font-medium">Active sites</h2>
            {sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{data ? 'No visitors in the last 5 minutes.' : 'Loading…'}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {sites.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={siteHref(s.id)}
                      className="flex h-8 items-center justify-between gap-3 rounded-md px-2 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="bidi-isolate min-w-0 truncate">{displayText(s.name)}</span>
                      <span className="flex items-center gap-1.5 font-medium tabular-nums">
                        <LiveDot active />
                        {formatNumber(s.visitors)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-medium">Top countries</h2>
            <LiveCountryList countries={data?.countries ?? []} limit={5} />
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------------- Site live page body ---------------- */

export function SiteLiveView({ siteId }: { siteId: string }) {
  const { data, error, series, pings, now } = useSiteLive(siteId);
  const countries = useMemo(() => globeCountries(data?.countries), [data]);
  const recent = Array.isArray(data?.recent) ? data.recent : [];
  const visitors = data ? data.visitors : null;

  if (error && !data) {
    return (
      <Card>
        <CardContent>
          <ErrorState message={error} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="relative gap-0 overflow-hidden py-0 lg:col-span-2">
        <Globe countries={countries} pings={pings} valueLabel="visitors" scrollZoom={false} formatValue={formatNumber} className="h-80 w-full sm:h-[26rem] lg:h-[30rem]">
          <div className="pointer-events-none absolute top-4 left-4">
            <LiveCounter visitors={visitors} label={visitors === 1 ? 'visitor online' : 'visitors online'} />
          </div>
        </Globe>
      </Card>
      <Card className="gap-0 py-0 lg:max-h-[30rem]">
        <CardHeader className="flex h-12 items-center border-b px-4 py-0 [.border-b]:pb-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ActivityIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Recent pageviews
          </CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 py-1">
          <LiveFeed recent={recent} now={now} className="min-h-64" />
        </CardContent>
      </Card>
      <Card className="gap-2 lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">Visitors online</CardTitle>
          <CardDescription>Last 5 minutes, updated every 5 seconds while this tab is open.</CardDescription>
        </CardHeader>
        <CardContent className="px-2">
          <LiveVisitorsChart series={series} value={visitors ?? 0} />
        </CardContent>
      </Card>
      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <GlobeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Countries
          </CardTitle>
          <CardDescription>Visitors in the last 5 minutes.</CardDescription>
        </CardHeader>
        <CardContent className="px-2">
          <LiveCountryList countries={data?.countries ?? []} limit={7} />
        </CardContent>
      </Card>
    </div>
  );
}
