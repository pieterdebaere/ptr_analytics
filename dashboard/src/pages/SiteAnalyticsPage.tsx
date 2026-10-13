import { lazy, Suspense, useMemo, useState } from 'react';
import { DownloadIcon, MapIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { FilterKey, SummaryResponse, TimeseriesResponse } from '@/api/types';
import { BreakdownPanel, EventDetailDialog, FilterChips, LiveIndicator, type PanelTab } from '@/components/analytics';
import { ChangeBadge, EmptyState, ErrorState } from '@/components/common';
import { PeriodSelector } from '@/components/PeriodSelector';
import { TimeSeriesChart, type SeriesPoint } from '@/components/stats-charts';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/hooks/useApi';
import { useStatsQuery } from '@/hooks/useStatsQuery';
import { linkHostname } from '@/lib/dimensions';
import { formatCompact, formatNumber, formatPercent, percentChange } from '@/lib/format';
import { exportUrl } from '@/lib/query';
import { cn } from '@/lib/utils';
import { useSite } from './SiteLayout';

const CountryMap = lazy(() => import('@/components/CountryMap'));

type Kpi = 'visitors' | 'pageviews' | 'bounceRate';

const KPI_LABELS: Record<Kpi, string> = {
  visitors: 'Visitors',
  pageviews: 'Page Views',
  bounceRate: 'Bounce Rate',
};

const PAGES_TABS: PanelTab[] = [
  { key: 'path', label: 'Pages' },
  { key: 'hostname', label: 'Hostnames' },
];
const REFERRER_TABS: PanelTab[] = [
  { key: 'referrer', label: 'Referrers' },
  { key: 'utm_source', label: 'Source' },
  { key: 'utm_medium', label: 'Medium' },
  { key: 'utm_campaign', label: 'Campaign' },
  { key: 'utm_term', label: 'Term' },
  { key: 'utm_content', label: 'Content' },
];
const COUNTRY_TABS: PanelTab[] = [{ key: 'country', label: 'Countries' }];
const DEVICE_TABS: PanelTab[] = [
  { key: 'device', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'os', label: 'OS' },
];
const EVENT_TABS: PanelTab[] = [{ key: 'event', label: 'Events' }];

export function SiteAnalyticsPage() {
  const { site } = useSite();
  const { query, period, filters, tz, setPeriod, setFilter, clearFilters } = useStatsQuery();
  const [kpi, setKpi] = useState<Kpi>('visitors');
  const [eventDetail, setEventDetail] = useState<string | null>(null);
  const queryKey = JSON.stringify(query);

  const summary = useApi((signal) => api.summary(site.id, query, signal), [site.id, queryKey]);
  const series = useApi((signal) => api.timeseries(site.id, query, signal), [site.id, queryKey]);
  const pageHost = linkHostname(filters.hostname, site.domains);

  const onFilter = (key: FilterKey, value: string) => setFilter(key, value);
  const panelProps = { siteId: site.id, query, pageHost, siteDomains: site.domains, onFilter };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <PeriodSelector value={period} onChange={setPeriod} />
          <LiveIndicator siteId={site.id} tz={tz} href={`/sites/${encodeURIComponent(site.id)}/live`} />
        </div>
        <a className={cn(buttonVariants({ variant: 'outline' }), 'bg-background')} href={exportUrl(site.id, query)} download>
          <DownloadIcon aria-hidden="true" />
          <span>Export CSV</span>
        </a>
      </div>

      <FilterChips filters={filters} onRemove={(k) => setFilter(k, null)} onClear={clearFilters} />

      <Card className="gap-0 py-0">
        <KpiTabs summary={summary.data} loading={summary.loading} error={summary.error} onRetry={summary.reload} kpi={kpi} onSelect={setKpi} />
        <div className="px-2 pt-4 pb-2 sm:px-4">
          <MainChart data={series.data} loading={series.loading} error={series.error} onRetry={series.reload} kpi={kpi} />
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownPanel {...panelProps} tabs={PAGES_TABS} />
        <BreakdownPanel {...panelProps} tabs={REFERRER_TABS} />
        <BreakdownPanel
          {...panelProps}
          tabs={COUNTRY_TABS}
          extraViews={{
            icon: <MapIcon aria-hidden="true" />,
            label: 'Map',
            render: (rows) => (
              <Suspense fallback={<Skeleton className="mx-2 mt-2 h-64" />}>
                <CountryMap rows={rows} />
              </Suspense>
            ),
          }}
        />
        <BreakdownPanel {...panelProps} tabs={DEVICE_TABS} />
        <BreakdownPanel
          {...panelProps}
          tabs={EVENT_TABS}
          countLabel="Events"
          onSelectRow={(_k, row) => {
            if (row.value !== null) setEventDetail(row.value);
          }}
        />
      </div>

      {eventDetail !== null ? (
        <EventDetailDialog
          siteId={site.id}
          query={query}
          event={eventDetail}
          onClose={() => setEventDetail(null)}
          onFilter={() => {
            setFilter('event', eventDetail);
            setEventDetail(null);
          }}
        />
      ) : null}
    </div>
  );
}

function KpiTabs({
  summary,
  loading,
  error,
  onRetry,
  kpi,
  onSelect,
}: {
  summary: SummaryResponse | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  kpi: Kpi;
  onSelect: (k: Kpi) => void;
}) {
  if (error) return <ErrorState message={error} onRetry={onRetry} className="border-b" />;
  const values: Record<Kpi, { value: string; title?: string; change: number | null; lowerIsBetter?: boolean }> | null = summary
    ? {
        visitors: {
          value: formatCompact(summary.visitors),
          title: formatNumber(summary.visitors),
          change: percentChange(summary.visitors, summary.previous?.visitors),
        },
        pageviews: {
          value: formatCompact(summary.pageviews),
          title: formatNumber(summary.pageviews),
          change: percentChange(summary.pageviews, summary.previous?.pageviews),
        },
        bounceRate: {
          value: formatPercent(summary.bounceRate),
          change: percentChange(summary.bounceRate, summary.previous?.bounceRate),
          lowerIsBetter: true,
        },
      }
    : null;
  return (
    <div className="grid grid-cols-3 border-b" role="tablist" aria-label="Metric">
      {(['visitors', 'pageviews', 'bounceRate'] as const).map((key) => {
        const it = values?.[key];
        const active = kpi === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            className={cn(
              'relative flex min-w-0 flex-col items-start gap-1 border-r px-3 py-3 text-left outline-none transition-colors last:border-r-0 hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5 sm:py-4',
              'after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-chart-1 after:opacity-0 after:transition-opacity',
              active && 'bg-muted/30 after:opacity-100',
            )}
            onClick={() => onSelect(key)}
          >
            <span className={cn('truncate text-xs font-medium text-muted-foreground sm:text-sm', active && 'text-foreground')}>{KPI_LABELS[key]}</span>
            {it && !(loading && !summary) ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xl font-semibold tracking-tight tabular-nums sm:text-3xl" title={it.title}>
                  {it.value}
                </span>
                <ChangeBadge change={it.change} lowerIsBetter={it.lowerIsBetter} />
              </span>
            ) : (
              <Skeleton className="h-7 w-20 sm:h-9" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function MainChart({
  data,
  loading,
  error,
  onRetry,
  kpi,
}: {
  data: TimeseriesResponse | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  kpi: Kpi;
}) {
  const points = useMemo<SeriesPoint[]>(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      t: p.t,
      value: kpi === 'bounceRate' ? (typeof p.bounceRate === 'number' ? p.bounceRate : null) : (p[kpi] ?? 0),
    }));
  }, [data, kpi]);

  if (error) return <ErrorState message={error} onRetry={onRetry} className="min-h-56" />;
  if (data && kpi === 'bounceRate' && !data.points.some((p) => p.bounceRate !== undefined)) {
    return (
      <EmptyState title="Bounce rate over time is not available" className="min-h-56">
        <p>The total bounce rate for the period is shown above.</p>
      </EmptyState>
    );
  }
  const label = kpi === 'visitors' ? 'Visitors' : kpi === 'pageviews' ? 'Page views' : 'Bounce rate';
  return (
    <TimeSeriesChart
      key={kpi}
      points={points}
      interval={data?.interval ?? 'day'}
      loading={loading || !data}
      label={`${label} over time`}
      valueLabel={label}
      formatValue={kpi === 'bounceRate' ? (v) => formatPercent(v) : (v) => formatNumber(v)}
      formatTick={kpi === 'bounceRate' ? (v) => formatPercent(v) : (v) => formatCompact(v)}
    />
  );
}
