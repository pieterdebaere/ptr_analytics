import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLinkIcon, GaugeIcon, MonitorIcon, SmartphoneIcon } from 'lucide-react';
import { api } from '@/api/client';
import {
  VITAL_METRICS,
  type Rating,
  type VitalDimension,
  type VitalMetric,
  type VitalsQuery,
  type VitalsSummaryResponse,
} from '@/api/types';
import { FilterChip, PanelTabs } from '@/components/analytics';
import { Gauge } from '@/components/charts/gauge';
import { EmptyState, ErrorState, InfoTip, SkeletonRows } from '@/components/common';
import { PeriodSelector } from '@/components/PeriodSelector';
import { TimeSeriesChart, type ReferenceBand } from '@/components/stats-charts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useApi } from '@/hooks/useApi';
import { useStatsQuery } from '@/hooks/useStatsQuery';
import { displayValue, linkHostname, rowHref, valuePrefix } from '@/lib/dimensions';
import { formatNumber } from '@/lib/format';
import { parseVitalDevice } from '@/lib/query';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import {
  METRIC_INFO,
  RATING_LABELS,
  RES_DESCRIPTION,
  THRESHOLDS,
  formatVital,
  isRating,
  rateScore,
  rateValue,
} from '@/lib/vitals';
import { useSite } from './SiteLayout';

const BREAKDOWN_TABS: { key: VitalDimension; label: string }[] = [
  { key: 'path', label: 'Pages' },
  { key: 'country', label: 'Countries' },
  { key: 'device', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'os', label: 'OS' },
  { key: 'hostname', label: 'Hostnames' },
];

const RATING_COLOR: Record<Rating, string> = {
  good: 'var(--good)',
  'needs-improvement': 'var(--warn)',
  poor: 'var(--poor)',
};

const RATING_TEXT: Record<Rating, string> = {
  good: 'text-good',
  'needs-improvement': 'text-warn',
  poor: 'text-poor',
};

const RATING_BG: Record<Rating, string> = {
  good: 'bg-good',
  'needs-improvement': 'bg-warn',
  poor: 'bg-poor',
};

function parseMetric(v: string | null): VitalMetric {
  return (VITAL_METRICS as readonly string[]).includes(v ?? '') ? (v as VitalMetric) : 'LCP';
}

export function SpeedInsightsPage() {
  const { site } = useSite();
  const { period, setPeriod, tz, filters } = useStatsQuery();
  const [params, setParams] = useSearchParams();
  const device = parseVitalDevice(params.get('device'));
  const metric = parseMetric(params.get('metric'));
  const path = filters.path;

  const q = useMemo<VitalsQuery>(() => ({ ...period, tz, device, path }), [period, tz, device, path]);
  const qKey = JSON.stringify(q);

  const setParam = (key: string, value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });

  const summary = useApi((signal) => api.vitalsSummary(site.id, q, signal), [site.id, qKey]);
  const hasData = summary.data ? VITAL_METRICS.some((m) => (summary.data!.metrics[m]?.count ?? 0) > 0) : false;
  const deviceValue = device === 'desktop' || device === 'mobile' ? device : 'all';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelector value={period} onChange={setPeriod} />
        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[deviceValue]}
          onValueChange={(v: unknown[]) => {
            const k = v[0];
            if (k === 'desktop' || k === 'mobile') setParam('device', k);
            else if (k === 'all') setParam('device', null);
          }}
          aria-label="Device"
          className="bg-background dark:bg-transparent"
        >
          <ToggleGroupItem value="all" aria-label="All devices">
            All devices
          </ToggleGroupItem>
          <ToggleGroupItem value="desktop" aria-label="Desktop">
            <MonitorIcon aria-hidden="true" />
            <span className="max-sm:sr-only">Desktop</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="mobile" aria-label="Mobile">
            <SmartphoneIcon aria-hidden="true" />
            <span className="max-sm:sr-only">Mobile</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {path !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip label="Page" value={path ? displayText(path) : 'Unknown'} onRemove={() => setParam('path', null)} />
        </div>
      ) : null}

      {summary.error ? (
        <Card>
          <ErrorState message={summary.error} onRetry={summary.reload} />
        </Card>
      ) : !summary.data ? (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <Skeleton className="h-64 rounded-xl" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {VITAL_METRICS.map((m) => (
              <Skeleton key={m} className="h-36 rounded-xl" />
            ))}
          </div>
        </div>
      ) : !hasData ? (
        <Card>
          <EmptyState title="No Speed Insights data yet" icon={<GaugeIcon />}>
            <p>
              Speed Insights data appears after visitors leave your pages: the tracking script measures Core Web Vitals
              (LCP, INP, CLS, FCP, TTFB) in real browsers and sends them when the page is hidden or closed. Make sure the
              script is installed and <code>data-vitals</code> is not set to <code>false</code>.
            </p>
          </EmptyState>
        </Card>
      ) : (
        <>
          <VitalsOverview data={summary.data} metric={metric} onSelect={(m) => setParam('metric', m === 'LCP' ? null : m)} />
          <VitalChart siteId={site.id} q={q} qKey={qKey} metric={metric} />
          <VitalBreakdown
            siteId={site.id}
            q={q}
            qKey={qKey}
            metric={metric}
            pageHost={linkHostname(undefined, site.domains)}
            siteDomains={site.domains}
            onFilterPath={(p) => setParam('path', p)}
          />
        </>
      )}
    </div>
  );
}

/** Position (0..1) of a value on a 3-segment good / needs improvement / poor scale. */
function scalePosition(metric: VitalMetric, value: number): number {
  const { good, poor } = THRESHOLDS[metric];
  if (value <= good) return (value / good) / 3;
  if (value <= poor) return 1 / 3 + ((value - good) / (poor - good)) / 3;
  return Math.min(1, 2 / 3 + ((value - poor) / poor) / 3);
}

function RatingScale({ metric, value }: { metric: VitalMetric; value: number | null }) {
  return (
    <div className="relative mt-1 flex h-1.5 gap-0.5" aria-hidden="true">
      <span className="flex-1 rounded-l-full bg-good/70" />
      <span className="flex-1 bg-warn/70" />
      <span className="flex-1 rounded-r-full bg-poor/70" />
      {value !== null ? (
        <span
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground"
          style={{ left: `${scalePosition(metric, value) * 100}%` }}
        />
      ) : null}
    </div>
  );
}

function VitalsOverview({ data, metric, onSelect }: { data: VitalsSummaryResponse; metric: VitalMetric; onSelect: (m: VitalMetric) => void }) {
  const scoreRating = rateScore(data.score);
  const score = data.score === null ? null : Math.round(data.score);
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="items-center gap-2" aria-label="Real Experience Score" role="region">
        <CardHeader className="w-full">
          <CardTitle className="flex items-center gap-1 text-sm">
            Real Experience Score
            <InfoTip text={RES_DESCRIPTION} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-2">
          <div className="relative">
            <Gauge
              value={score ?? 0}
              width={176}
              height={176}
              minWidth={0}
              totalNotches={36}
              activeFill={scoreRating ? RATING_COLOR[scoreRating] : 'var(--muted-foreground)'}
              inactiveFill="var(--muted)"
              inactiveFillOpacity={1}
            />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" role="img" aria-label={score === null ? 'No score' : `Score ${score} of 100`}>
              <span className={cn('text-4xl font-semibold tracking-tight tabular-nums', scoreRating && RATING_TEXT[scoreRating])} aria-hidden="true">
                {score === null ? '–' : score}
              </span>
              <span className="text-xs text-muted-foreground" aria-hidden="true">
                of 100
              </span>
            </div>
          </div>
          <div className={cn('text-sm font-medium', scoreRating ? RATING_TEXT[scoreRating] : 'text-muted-foreground')}>
            {scoreRating ? (scoreRating === 'good' ? 'Great' : scoreRating === 'poor' ? 'Poor' : 'Needs improvement') : 'Not enough data'}
          </div>
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <i className="size-2 rounded-full bg-poor" aria-hidden="true" /> 0–49
            </span>
            <span className="flex items-center gap-1">
              <i className="size-2 rounded-full bg-warn" aria-hidden="true" /> 50–89
            </span>
            <span className="flex items-center gap-1">
              <i className="size-2 rounded-full bg-good" aria-hidden="true" /> 90–100
            </span>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" role="tablist" aria-label="Metric">
        {VITAL_METRICS.map((m) => {
          const s = data.metrics[m];
          const rating = s && isRating(s.rating) ? s.rating : rateValue(m, s?.p75);
          const active = metric === m;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              className={cn(
                'flex min-w-0 flex-col gap-3 rounded-xl bg-card p-3.5 text-left ring-1 ring-foreground/10 outline-none transition-shadow hover:ring-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50',
                active && 'ring-2 ring-chart-1 hover:ring-chart-1',
              )}
              onClick={() => onSelect(m)}
            >
              <span className="flex flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold">{m}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums" title="Samples">
                    {formatNumber(s?.count ?? 0)}
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{METRIC_INFO[m].name}</span>
              </span>
              <span className="mt-auto flex flex-col gap-2">
                <span className={cn('text-2xl font-semibold tracking-tight tabular-nums', rating && RATING_TEXT[rating])}>
                  {formatVital(m, s?.p75 ?? null)}
                </span>
                <RatingScale metric={m} value={s?.p75 ?? null} />
                <span className={cn('flex items-start gap-1.5 text-xs leading-tight font-medium', rating ? RATING_TEXT[rating] : 'text-muted-foreground')}>
                  <i className={cn('mt-[0.3em] size-1.5 shrink-0 rounded-full', rating ? RATING_BG[rating] : 'bg-muted-foreground/40')} aria-hidden="true" />
                  <span>{rating ? RATING_LABELS[rating] : 'No data'}</span>
                </span>
                <span className="sr-only">{formatNumber(s?.count ?? 0)} samples</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VitalChart({ siteId, q, qKey, metric }: { siteId: string; q: VitalsQuery; qKey: string; metric: VitalMetric }) {
  const { data, error, loading, reload } = useApi((signal) => api.vitalsTimeseries(siteId, q, metric, signal), [siteId, qKey, metric]);
  const points = useMemo(() => (data?.points ?? []).map((p) => ({ t: p.t, value: typeof p.value === 'number' ? p.value : null })), [data]);
  const counts = useMemo(() => new Map((data?.points ?? []).map((p) => [p.t, p.count])), [data]);
  const t = THRESHOLDS[metric];
  const bands: ReferenceBand[] = [
    { y1: 0, y2: t.good, color: 'var(--good)' },
    { y1: t.good, y2: t.poor, color: 'var(--warn)', label: `Good ≤ ${formatVital(metric, t.good)}` },
    { y1: t.poor, color: 'var(--poor)', label: `Poor > ${formatVital(metric, t.poor)}` },
  ];
  const info = METRIC_INFO[metric];
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">
          {info.name} <span className="font-normal text-muted-foreground">({metric}, p75)</span>
        </CardTitle>
        <CardDescription>{info.description}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        {error ? (
          <ErrorState message={error} onRetry={reload} className="min-h-56" />
        ) : (
          <TimeSeriesChart
            key={metric}
            points={points}
            interval={data?.interval ?? 'day'}
            loading={loading || !data}
            label={`${metric} p75 over time`}
            valueLabel={`${metric} p75`}
            bands={bands}
            note={(ts) => {
              const c = counts.get(ts);
              return c === undefined ? null : `${formatNumber(c)} samples`;
            }}
            formatValue={(v) => formatVital(metric, v)}
            formatTick={(v) => (metric === 'CLS' ? String(Math.round(v * 1000) / 1000) : formatVital(metric, v))}
          />
        )}
      </CardContent>
    </Card>
  );
}

function VitalBreakdown({
  siteId,
  q,
  qKey,
  metric,
  pageHost,
  siteDomains,
  onFilterPath,
}: {
  siteId: string;
  q: VitalsQuery;
  qKey: string;
  metric: VitalMetric;
  pageHost: string | null;
  siteDomains: readonly string[];
  onFilterPath: (path: string) => void;
}) {
  const [dim, setDim] = useState<VitalDimension>('path');
  const { data, error, loading, reload } = useApi((signal) => api.vitalsBreakdown(siteId, q, metric, dim, 50, signal), [siteId, qKey, metric, dim]);
  const dimLabel = BREAKDOWN_TABS.find((t) => t.key === dim)?.label ?? '';
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex min-h-12 items-center border-b px-4 py-0 [.border-b]:pb-0">
        <PanelTabs tabs={BREAKDOWN_TABS} value={dim} onChange={setDim} label="Breakdown" />
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <SkeletonRows className="p-4" />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState title="No data for this period" />
        ) : (
          <div className={cn('transition-opacity', loading && 'opacity-60')}>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">{dimLabel}</TableHead>
                  <TableHead className="w-28 text-right sm:w-36">{metric} p75</TableHead>
                  <TableHead className="w-20 pr-4 text-right sm:w-28">Samples</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => {
                  const rating = isRating(r.rating) ? r.rating : rateValue(metric, r.p75);
                  const label = displayValue(dim, r.value);
                  const prefix = valuePrefix(dim, r.value);
                  const href = rowHref(dim, r.value, pageHost, siteDomains);
                  return (
                    <TableRow key={`${r.value ?? '\u0000'}-${i}`} className="group/row">
                      <TableCell className="pl-4">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {dim === 'path' && r.value !== null ? (
                            <button
                              type="button"
                              className="bidi-isolate min-w-0 truncate text-left outline-none hover:underline focus-visible:underline"
                              title={`Show only ${label}`}
                              onClick={() => onFilterPath(r.value ?? '')}
                            >
                              {label}
                            </button>
                          ) : (
                            <span className={cn('bidi-isolate min-w-0 truncate', r.value === null && 'text-muted-foreground')}>
                              {prefix ? `${prefix} ` : ''}
                              {label}
                            </span>
                          )}
                          {href ? (
                            <a
                              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              aria-label={`Open ${label} in a new tab`}
                            >
                              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className={cn('text-right font-medium tabular-nums', rating && RATING_TEXT[rating])}>
                        <span className="inline-flex items-center gap-1.5">
                          <i className={cn('size-1.5 rounded-full', rating ? RATING_BG[rating] : 'bg-muted-foreground/40')} aria-hidden="true" />
                          {formatVital(metric, r.p75)}
                        </span>
                        <span className="sr-only"> ({rating ? RATING_LABELS[rating] : 'no rating'})</span>
                      </TableCell>
                      <TableCell className="pr-4 text-right text-muted-foreground tabular-nums">{formatNumber(r.count)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
