import { useMemo, useState } from 'react';
import { api } from '../api/client';
import type { FilterKey, SummaryResponse, TimeseriesResponse } from '../api/types';
import {
  BreakdownPanel,
  EventDetailModal,
  FilterChips,
  LiveIndicator,
  type PanelTab,
} from '../components/analytics';
import { AreaChart, type ChartPoint } from '../components/charts';
import { DownloadIcon } from '../components/Icons';
import { PeriodSelector } from '../components/PeriodSelector';
import { ChangeBadge, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useStatsQuery } from '../hooks/useStatsQuery';
import { linkHostname } from '../lib/dimensions';
import { formatCompact, formatNumber, formatPercent, percentChange } from '../lib/format';
import { exportUrl } from '../lib/query';
import { useSite } from './SiteLayout';

type Kpi = 'visitors' | 'pageviews' | 'bounceRate';

const PAGES_TABS: PanelTab[] = [
  { key: 'path', label: 'Pages' },
  { key: 'hostname', label: 'Hostnames' },
];
const REFERRER_TABS: PanelTab[] = [
  { key: 'referrer', label: 'Referrers' },
  { key: 'utm_source', label: 'UTM Source' },
  { key: 'utm_medium', label: 'UTM Medium' },
  { key: 'utm_campaign', label: 'UTM Campaign' },
  { key: 'utm_term', label: 'UTM Term' },
  { key: 'utm_content', label: 'UTM Content' },
];
const COUNTRY_TABS: PanelTab[] = [{ key: 'country', label: 'Countries' }];
const DEVICE_TABS: PanelTab[] = [
  { key: 'device', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'os', label: 'Operating Systems' },
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

  return (
    <div className="analytics">
      <div className="toolbar">
        <div className="toolbar-left">
          <PeriodSelector value={period} onChange={setPeriod} />
          <LiveIndicator siteId={site.id} tz={tz} />
        </div>
        <a className="btn btn-sm" href={exportUrl(site.id, query)} download>
          <DownloadIcon />
          <span>Export CSV</span>
        </a>
      </div>

      <FilterChips filters={filters} onRemove={(k) => setFilter(k, null)} onClear={clearFilters} />

      <section className="card main-chart-card">
        <KpiTabs summary={summary.data} loading={summary.loading} error={summary.error} onRetry={summary.reload} kpi={kpi} onSelect={setKpi} />
        <div className="main-chart">
          <MainChart data={series.data} loading={series.loading} error={series.error} onRetry={series.reload} kpi={kpi} />
        </div>
      </section>

      <div className="panels">
        <BreakdownPanel siteId={site.id} query={query} tabs={PAGES_TABS} pageHost={pageHost} siteDomains={site.domains} onFilter={onFilter} />
        <BreakdownPanel siteId={site.id} query={query} tabs={REFERRER_TABS} pageHost={pageHost} siteDomains={site.domains} onFilter={onFilter} />
        <BreakdownPanel siteId={site.id} query={query} tabs={COUNTRY_TABS} pageHost={pageHost} siteDomains={site.domains} onFilter={onFilter} />
        <BreakdownPanel siteId={site.id} query={query} tabs={DEVICE_TABS} pageHost={pageHost} siteDomains={site.domains} onFilter={onFilter} />
        <BreakdownPanel
          siteId={site.id}
          query={query}
          tabs={EVENT_TABS}
          pageHost={pageHost}
          siteDomains={site.domains}
          countLabel="Events"
          onFilter={onFilter}
          onSelectRow={(_k, row) => {
            if (row.value !== null) setEventDetail(row.value);
          }}
        />
      </div>

      {eventDetail !== null ? (
        <EventDetailModal
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
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  const items: { key: Kpi; label: string; value: string; title?: string; change: number | null; lowerIsBetter?: boolean }[] = summary
    ? [
        {
          key: 'visitors',
          label: 'Visitors',
          value: formatCompact(summary.visitors),
          title: formatNumber(summary.visitors),
          change: percentChange(summary.visitors, summary.previous?.visitors),
        },
        {
          key: 'pageviews',
          label: 'Page Views',
          value: formatCompact(summary.pageviews),
          title: formatNumber(summary.pageviews),
          change: percentChange(summary.pageviews, summary.previous?.pageviews),
        },
        {
          key: 'bounceRate',
          label: 'Bounce Rate',
          value: formatPercent(summary.bounceRate),
          change: percentChange(summary.bounceRate, summary.previous?.bounceRate),
          lowerIsBetter: true,
        },
      ]
    : [];
  return (
    <div className="kpis" role="tablist" aria-label="Metric">
      {(['visitors', 'pageviews', 'bounceRate'] as const).map((key, i) => {
        const it = items[i];
        const label = key === 'visitors' ? 'Visitors' : key === 'pageviews' ? 'Page Views' : 'Bounce Rate';
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={kpi === key}
            className={`kpi${kpi === key ? ' kpi-active' : ''}`}
            onClick={() => onSelect(key)}
          >
            <span className="kpi-label">{label}</span>
            {it && !(loading && !summary) ? (
              <span className="kpi-value">
                <span title={it.title}>{it.value}</span>
                <ChangeBadge change={it.change} lowerIsBetter={it.lowerIsBetter} />
              </span>
            ) : (
              <Skeleton className="skeleton-kpi" />
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
  const points = useMemo<ChartPoint[]>(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      t: p.t,
      value: kpi === 'bounceRate' ? (typeof p.bounceRate === 'number' ? p.bounceRate : null) : (p[kpi] ?? 0),
    }));
  }, [data, kpi]);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (!data) return <Skeleton className="skeleton-chart" />;
  if (kpi === 'bounceRate' && !data.points.some((p) => p.bounceRate !== undefined)) {
    return (
      <EmptyState title="Bounce rate over time is not available">
        <p>The total bounce rate for the period is shown above.</p>
      </EmptyState>
    );
  }
  const label = kpi === 'visitors' ? 'Visitors' : kpi === 'pageviews' ? 'Page views' : 'Bounce rate';
  return (
    <div className={loading ? 'is-loading' : undefined}>
      <AreaChart
        points={points}
        interval={data.interval}
        label={`${label} over time`}
        valueLabel={label}
        integer={kpi !== 'bounceRate'}
        formatValue={kpi === 'bounceRate' ? (v) => formatPercent(v) : (v) => formatNumber(v)}
        formatTick={kpi === 'bounceRate' ? (v) => formatPercent(v) : (v) => formatCompact(v)}
      />
    </div>
  );
}
