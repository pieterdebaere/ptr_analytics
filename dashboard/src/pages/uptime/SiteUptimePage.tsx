import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ActivityIcon, PlusIcon, WrenchIcon } from 'lucide-react';
import { uptimeApi, type Monitor, type MonitorStats, type UptimePeriod } from '@/api/uptime';
import { EmptyState, ErrorState } from '@/components/common';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveMonitors } from '@/components/uptime/live';
import { displayStatus, formatUptime, uptimeTone } from '@/components/uptime/lib';
import { MonitorList } from '@/components/uptime/MonitorList';
import { MonitorSuggestions } from '@/components/uptime/onboarding';
import { DownBanner } from '@/components/uptime/banner';
import { Toaster } from '@/components/uptime/toast';
import { LiveBadge } from '@/components/uptime/widgets';
import { useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { timeZone } from '@/hooks/useStatsQuery';
import { cn } from '@/lib/utils';
import { useSite } from '../SiteLayout';

const TILE_PERIODS: Array<{ period: Exclude<UptimePeriod, 'custom'>; label: string }> = [
  { period: '24h', label: 'Last 24 hours' },
  { period: '7d', label: 'Last 7 days' },
  { period: '30d', label: 'Last 30 days' },
  { period: '90d', label: 'Last 90 days' },
];

/** Max monitors whose stats are fetched for the site tiles. */
const TILE_MONITOR_LIMIT = 25;

function mean(values: Array<number | null>): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function siteUptime(monitors: Monitor[], signal: AbortSignal): Promise<Record<string, { uptime: number | null; previous: number | null }>> {
  const list = monitors.filter((m) => m.type !== 'group').slice(0, TILE_MONITOR_LIMIT);
  const jobs = TILE_PERIODS.flatMap(({ period }) => list.map((m) => ({ period, uid: m.uid })));
  const results = new Map<string, MonitorStats[]>();
  let i = 0;
  const worker = async () => {
    while (i < jobs.length && !signal.aborted) {
      const job = jobs[i++]!;
      try {
        const s = await uptimeApi.stats(job.uid, { period: job.period, tz: timeZone }, signal);
        const arr = results.get(job.period) ?? [];
        arr.push(s);
        results.set(job.period, arr);
      } catch (err) {
        if (signal.aborted) throw err;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return Object.fromEntries(
    TILE_PERIODS.map(({ period }) => {
      const s = results.get(period) ?? [];
      return [period, { uptime: mean(s.map((x) => x.uptime)), previous: mean(s.map((x) => x.previousUptime)) }];
    }),
  );
}

function deltaText(cur: number | null, prev: number | null): { text: string; tone: string } | null {
  if (cur === null || prev === null) return null;
  const pp = (cur - prev) * 100;
  if (Math.abs(pp) < 0.005) return { text: 'same as previous period', tone: 'text-muted-foreground' };
  return { text: `${pp > 0 ? '+' : '−'}${Math.abs(pp).toFixed(2)} pp vs previous`, tone: pp > 0 ? 'text-good-text' : 'text-poor-text' };
}

export function SiteUptimePage() {
  const { site } = useSite();
  const canManage = useCanManageSites();
  const live = useLiveMonitors((signal) => uptimeApi.siteMonitors(site.id, signal), [site.id]);
  const types = useApi((signal) => uptimeApi.types(signal), []);
  const typeLabels = useMemo(() => Object.fromEntries((types.data?.types ?? []).map((t) => [t.type, t.label])), [types.data]);
  const monitors = live.monitors;
  const uidKey = (monitors ?? []).map((m) => m.uid).join(',');
  const tiles = useApi(
    (signal) => siteUptime(monitors ?? [], signal),
    [uidKey],
    monitors !== undefined && monitors.length > 0,
  );
  const down = (monitors ?? []).filter((m) => displayStatus(m) === 'down');
  const newHref = `/monitors/new?site=${encodeURIComponent(site.id)}`;

  if (live.error && !monitors) {
    return (
      <Card>
        <ErrorState message={live.error} onRetry={live.reload} />
      </Card>
    );
  }
  if (!monitors) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LiveBadge mode={live.mode} />
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/maintenance" className={cn(buttonVariants({ variant: 'outline' }), 'bg-background')}>
            <WrenchIcon aria-hidden="true" />
            Maintenance
          </Link>
          {canManage ? (
            <Link to={newHref} className={buttonVariants()}>
              <PlusIcon aria-hidden="true" />
              New monitor
            </Link>
          ) : null}
        </div>
      </div>

      {monitors.length === 0 ? (
        <Card>
          <EmptyState title="This site has no monitors yet" icon={<ActivityIcon />}>
            <p>Get alerted when the site goes down, slows down or its certificate is about to expire.</p>
            {canManage ? (
              <div className="mt-4 flex flex-col items-center gap-4">
                <MonitorSuggestions sites={[site]} onCreated={live.reload} />
                <Link to={newHref} className={buttonVariants({ variant: 'outline' })}>
                  <PlusIcon aria-hidden="true" />
                  Other monitor types
                </Link>
              </div>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <>
          {down.length > 0 ? <DownBanner monitors={down} /> : null}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="list" aria-label="Site uptime">
            {TILE_PERIODS.map(({ period, label }) => {
              const v = tiles.data?.[period];
              const d = v ? deltaText(v.uptime, v.previous) : null;
              return (
                <div key={period} role="listitem" className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                  <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
                  {tiles.loading && !tiles.data ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <span className={cn('text-2xl font-semibold tracking-tight tabular-nums', uptimeTone(v?.uptime))}>{formatUptime(v?.uptime ?? null)}</span>
                  )}
                  <span className={cn('min-h-4 truncate text-xs', d?.tone ?? 'text-muted-foreground')}>{d?.text ?? (tiles.error ? 'Unavailable' : ' ')}</span>
                </div>
              );
            })}
          </div>
          <MonitorList
            monitors={monitors}
            beats={live.beats}
            typeLabels={typeLabels}
            canManage={canManage}
            onChanged={live.replace}
            onRemoved={live.remove}
            onReload={live.reload}
          />
        </>
      )}
      <Toaster />
    </div>
  );
}
