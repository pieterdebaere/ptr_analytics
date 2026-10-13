import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  VITAL_METRICS,
  type Rating,
  type VitalDimension,
  type VitalMetric,
  type VitalsQuery,
  type VitalsSummaryResponse,
} from '../api/types';
import { AreaChart, RingGauge, type ChartPoint, type Threshold } from '../components/charts';
import { CloseIcon, ExternalIcon } from '../components/Icons';
import { PeriodSelector } from '../components/PeriodSelector';
import { EmptyState, ErrorState, InfoTip, Skeleton, SkeletonRows, Tabs } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useStatsQuery } from '../hooks/useStatsQuery';
import { displayValue, linkHostname, rowHref, valuePrefix } from '../lib/dimensions';
import { formatNumber } from '../lib/format';
import { displayText } from '../lib/safety';
import { parseVitalDevice } from '../lib/query';
import {
  METRIC_INFO,
  RATING_LABELS,
  RES_DESCRIPTION,
  THRESHOLDS,
  formatVital,
  isRating,
  rateScore,
  rateValue,
} from '../lib/vitals';
import { useSite } from './SiteLayout';

const DEVICE_ITEMS: { key: 'all' | 'desktop' | 'mobile'; label: string }[] = [
  { key: 'all', label: 'All devices' },
  { key: 'desktop', label: 'Desktop' },
  { key: 'mobile', label: 'Mobile' },
];

const BREAKDOWN_TABS: { key: VitalDimension; label: string }[] = [
  { key: 'path', label: 'Pages' },
  { key: 'country', label: 'Countries' },
  { key: 'device', label: 'Devices' },
  { key: 'browser', label: 'Browsers' },
  { key: 'os', label: 'OS' },
  { key: 'hostname', label: 'Hostnames' },
];

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

  const q = useMemo<VitalsQuery>(
    () => ({ ...period, tz, device, path }),
    [period, tz, device, path],
  );
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

  return (
    <div className="speed">
      <div className="toolbar">
        <div className="toolbar-left">
          <PeriodSelector value={period} onChange={setPeriod} />
          <Tabs
            items={DEVICE_ITEMS}
            value={device === 'desktop' || device === 'mobile' ? device : 'all'}
            onChange={(k) => setParam('device', k === 'all' ? null : k)}
            label="Device"
            size="md"
          />
        </div>
      </div>

      {path !== undefined ? (
        <div className="filter-chips">
          <span className="chip chip-filter">
            <span className="chip-key">Page</span>
            <span className="chip-op">is</span>
            <span className="chip-value truncate bidi-isolate">{path ? displayText(path) : 'Unknown'}</span>
            <button type="button" className="chip-remove" aria-label="Remove page filter" onClick={() => setParam('path', null)}>
              <CloseIcon size={12} />
            </button>
          </span>
        </div>
      ) : null}

      {summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : !summary.data ? (
        <div className="vitals-top">
          <Skeleton className="skeleton-gauge" />
          <div className="vitals-cards">
            {VITAL_METRICS.map((m) => (
              <Skeleton key={m} className="skeleton-card" />
            ))}
          </div>
        </div>
      ) : !hasData ? (
        <div className="card">
          <EmptyState title="No Speed Insights data yet">
            <p>
              Speed Insights data appears after visitors leave your pages: the tracking script measures Core Web
              Vitals (LCP, INP, CLS, FCP, TTFB) in real browsers and sends them when the page is hidden or closed.
              Make sure the script is installed and <code>data-vitals</code> is not set to <code>false</code>.
            </p>
          </EmptyState>
        </div>
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

function ratingTone(r: Rating | null): 'good' | 'needs-improvement' | 'poor' | 'none' {
  return r ?? 'none';
}

function VitalsOverview({
  data,
  metric,
  onSelect,
}: {
  data: VitalsSummaryResponse;
  metric: VitalMetric;
  onSelect: (m: VitalMetric) => void;
}) {
  const scoreRating = rateScore(data.score);
  return (
    <div className="vitals-top">
      <section className="card res-card" aria-label="Real Experience Score">
        <div className="res-head">
          <h2 className="panel-title">Real Experience Score</h2>
          <InfoTip text={RES_DESCRIPTION} />
        </div>
        <RingGauge
          score={data.score}
          tone={ratingTone(scoreRating)}
          label={data.score === null ? 'No score' : `Score ${Math.round(data.score)} of 100`}
        />
        <div className={`rating-label rating-${ratingTone(scoreRating)}`}>
          {scoreRating ? (scoreRating === 'good' ? 'Great' : scoreRating === 'poor' ? 'Poor' : 'Needs improvement') : 'Not enough data'}
        </div>
        <div className="res-legend muted">
          <span>
            <i className="dot dot-poor" /> 0–49
          </span>
          <span>
            <i className="dot dot-needs-improvement" /> 50–89
          </span>
          <span>
            <i className="dot dot-good" /> 90–100
          </span>
        </div>
      </section>
      <div className="vitals-cards" role="tablist" aria-label="Metric">
        {VITAL_METRICS.map((m) => {
          const s = data.metrics[m];
          const rating = s && isRating(s.rating) ? s.rating : rateValue(m, s?.p75);
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={metric === m}
              className={`card vital-card${metric === m ? ' vital-card-active' : ''}`}
              onClick={() => onSelect(m)}
            >
              <span className="vital-head">
                <span className="vital-abbr">{m}</span>
                <span className="vital-name muted">{METRIC_INFO[m].name}</span>
              </span>
              <span className={`vital-value rating-${ratingTone(rating)}`}>{formatVital(m, s?.p75 ?? null)}</span>
              <span className="vital-foot">
                <span className={`badge badge-${ratingTone(rating)}`}>{rating ? RATING_LABELS[rating] : 'No data'}</span>
                <span className="muted">{formatNumber(s?.count ?? 0)} samples</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VitalChart({ siteId, q, qKey, metric }: { siteId: string; q: VitalsQuery; qKey: string; metric: VitalMetric }) {
  const { data, error, loading, reload } = useApi(
    (signal) => api.vitalsTimeseries(siteId, q, metric, signal),
    [siteId, qKey, metric],
  );
  const points = useMemo<ChartPoint[]>(
    () =>
      (data?.points ?? []).map((p) => ({
        t: p.t,
        value: typeof p.value === 'number' ? p.value : null,
        note: `${formatNumber(p.count)} samples`,
      })),
    [data],
  );
  const t = THRESHOLDS[metric];
  const thresholds: Threshold[] = [
    { value: t.good, label: `Good ≤ ${formatVital(metric, t.good)}`, tone: 'good' },
    { value: t.poor, label: `Poor > ${formatVital(metric, t.poor)}`, tone: 'poor' },
  ];
  const info = METRIC_INFO[metric];
  return (
    <section className="card vital-chart-card">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            {info.name} <span className="muted">({metric}, p75)</span>
          </h2>
          <p className="muted small">{info.description}</p>
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton className="skeleton-chart" />
      ) : (
        <div className={loading ? 'is-loading' : undefined}>
          <AreaChart
            points={points}
            interval={data.interval}
            label={`${metric} p75 over time`}
            valueLabel={`${metric} p75`}
            integer={metric !== 'CLS'}
            thresholds={thresholds}
            formatValue={(v) => formatVital(metric, v)}
            formatTick={(v) => (metric === 'CLS' ? String(v) : formatVital(metric, v))}
          />
        </div>
      )}
    </section>
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
  const { data, error, loading, reload } = useApi(
    (signal) => api.vitalsBreakdown(siteId, q, metric, dim, 50, signal),
    [siteId, qKey, metric, dim],
  );
  const dimLabel = BREAKDOWN_TABS.find((t) => t.key === dim)?.label ?? '';
  return (
    <section className="card panel">
      <div className="panel-header">
        <Tabs items={BREAKDOWN_TABS} value={dim} onChange={setDim} label="Breakdown" />
      </div>
      <div className="panel-body">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <SkeletonRows />
        ) : !data || data.rows.length === 0 ? (
          <EmptyState title="No data for this period" />
        ) : (
          <div className={`table-wrap${loading ? ' is-loading' : ''}`}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{dimLabel}</th>
                  <th scope="col" className="num">
                    {metric} p75
                  </th>
                  <th scope="col" className="num">
                    Samples
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => {
                  const rating = isRating(r.rating) ? r.rating : rateValue(metric, r.p75);
                  const label = displayValue(dim, r.value);
                  const prefix = valuePrefix(dim, r.value);
                  const href = rowHref(dim, r.value, pageHost, siteDomains);
                  return (
                    <tr key={`${r.value ?? '\u0000'}-${i}`}>
                      <td>
                        <div className="cell-label">
                        {dim === 'path' && r.value !== null ? (
                          <button type="button" className="link-btn truncate bidi-isolate" title={`Show only ${label}`} onClick={() => onFilterPath(r.value ?? '')}>
                            {label}
                          </button>
                        ) : (
                          <span className={`truncate bidi-isolate${r.value === null ? ' muted' : ''}`}>
                            {prefix ? `${prefix} ` : ''}
                            {label}
                          </span>
                        )}
                        {href ? (
                          <a className="row-link" href={href} target="_blank" rel="noopener noreferrer nofollow" aria-label={`Open ${label} in a new tab`}>
                            <ExternalIcon size={13} />
                          </a>
                        ) : null}
                        </div>
                      </td>
                      <td className={`num rating-${ratingTone(rating)}`}>
                        <i className={`dot dot-${ratingTone(rating)}`} aria-hidden="true" /> {formatVital(metric, r.p75)}
                        <span className="sr-only"> ({rating ? RATING_LABELS[rating] : 'no rating'})</span>
                      </td>
                      <td className="num">{formatNumber(r.count)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
