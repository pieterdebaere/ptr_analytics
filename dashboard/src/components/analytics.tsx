// Building blocks of the site analytics screen.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { FILTER_KEYS, type BreakdownRow, type FilterKey, type Filters, type StatsQuery } from '../api/types';
import { useApi } from '../hooks/useApi';
import { usePageVisible } from '../hooks/usePageVisible';
import { DIMENSION_LABELS, displayValue, filterValueFor, rowHref, valuePrefix } from '../lib/dimensions';
import { formatCompact, formatNumber } from '../lib/format';
import { CloseIcon, ExternalIcon, SearchIcon } from './Icons';
import { EmptyState, ErrorState, Modal, SkeletonRows, Tabs } from './ui';

/* ---------------- Live indicator ---------------- */

export const REALTIME_INTERVAL_MS = 30_000;

export function LiveIndicator({ siteId, tz }: { siteId: string; tz: string }) {
  const visible = usePageVisible();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    let ctrl = new AbortController();
    const load = () => {
      ctrl.abort();
      ctrl = new AbortController();
      api.realtime(siteId, tz, ctrl.signal).then(
        (r) => setCount(typeof r.visitors === 'number' ? r.visitors : null),
        () => {
          /* keep last value */
        },
      );
    };
    load();
    const timer = window.setInterval(load, REALTIME_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      ctrl.abort();
    };
  }, [siteId, tz, visible]);

  return (
    <span className="live" aria-live="polite" title="Visitors in the last 5 minutes">
      <span className={`live-dot${count ? ' live-dot-on' : ''}`} aria-hidden="true" />
      {count === null ? '– online' : `${formatNumber(count)} online`}
    </span>
  );
}

/* ---------------- Filter chips ---------------- */

export function FilterChips({
  filters,
  onRemove,
  onClear,
}: {
  filters: Filters;
  onRemove: (key: FilterKey) => void;
  onClear: () => void;
}) {
  const active = FILTER_KEYS.filter((k) => filters[k] !== undefined);
  if (active.length === 0) return null;
  return (
    <div className="filter-chips" aria-label="Active filters">
      {active.map((k) => {
        const raw = filters[k] ?? '';
        const value = raw === '' ? null : raw;
        const prefix = valuePrefix(k, value);
        return (
          <span key={k} className="chip chip-filter">
            <span className="chip-key">{DIMENSION_LABELS[k]}</span>
            <span className="chip-op">is</span>
            <span className="chip-value truncate">
              {prefix ? `${prefix} ` : ''}
              {displayValue(k, value)}
            </span>
            <button type="button" className="chip-remove" aria-label={`Remove ${DIMENSION_LABELS[k]} filter`} onClick={() => onRemove(k)}>
              <CloseIcon size={12} />
            </button>
          </span>
        );
      })}
      {active.length > 1 ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
          Clear all
        </button>
      ) : null}
    </div>
  );
}

/* ---------------- Breakdown rows ---------------- */

export type RowMetric = 'visitors' | 'count';

export function BreakdownRows({
  dimension,
  rows,
  metric,
  pageHost,
  onSelect,
}: {
  dimension: FilterKey;
  rows: readonly BreakdownRow[];
  metric: RowMetric;
  pageHost: string | null;
  onSelect: (row: BreakdownRow) => void;
}) {
  const sorted = useMemo(
    () => (metric === 'visitors' ? rows : [...rows].sort((a, b) => b.count - a.count)),
    [rows, metric],
  );
  const max = Math.max(1, ...sorted.map((r) => r[metric]));
  return (
    <ul className="rows">
      {sorted.map((row, i) => {
        const label = displayValue(dimension, row.value);
        const prefix = valuePrefix(dimension, row.value);
        const href = rowHref(dimension, row.value, pageHost);
        const v = row[metric];
        return (
          <li key={`${row.value ?? '\u0000null'}-${i}`} className="row">
            <button type="button" className="row-main" onClick={() => onSelect(row)} title={label}>
              <span className="row-bar" style={{ width: `${Math.max(0, Math.min(100, (v / max) * 100))}%` }} />
              <span className="row-label">
                {prefix ? <span className="row-flag">{prefix}</span> : null}
                <span className={`truncate${row.value === null ? ' muted' : ''}`}>{label}</span>
              </span>
            </button>
            {href ? (
              <a
                className="row-link"
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={`Open ${label} in a new tab`}
                title="Open in a new tab"
              >
                <ExternalIcon size={13} />
              </a>
            ) : null}
            <span className="row-value" title={formatNumber(v)}>
              {formatCompact(v)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- Panel ---------------- */

export interface PanelTab {
  key: FilterKey;
  label: string;
}

export function BreakdownPanel({
  siteId,
  query,
  tabs,
  pageHost,
  countLabel = 'Page views',
  onFilter,
  onSelectRow,
}: {
  siteId: string;
  query: StatsQuery;
  tabs: readonly PanelTab[];
  pageHost: string | null;
  countLabel?: string;
  onFilter: (key: FilterKey, value: string) => void;
  /** overrides the default click behaviour (filtering) */
  onSelectRow?: (key: FilterKey, row: BreakdownRow) => void;
}) {
  const [tab, setTab] = useState<FilterKey>(tabs[0]!.key);
  const [metric, setMetric] = useState<RowMetric>('visitors');
  const [viewAll, setViewAll] = useState(false);
  const queryKey = JSON.stringify(query);
  const { data, error, loading, reload } = useApi(
    (signal) => api.breakdown(siteId, query, tab, 10, signal),
    [siteId, queryKey, tab],
  );
  const title = tabs.find((t) => t.key === tab)?.label ?? '';
  const rows = data?.dimension === tab ? data.rows : undefined;
  const select = (row: BreakdownRow) => {
    if (onSelectRow) onSelectRow(tab, row);
    else onFilter(tab, filterValueFor(row.value));
  };

  return (
    <section className="card panel" aria-label={tabs.map((t) => t.label).join(', ')}>
      <div className="panel-header">
        {tabs.length > 1 ? (
          <Tabs items={tabs} value={tab} onChange={setTab} label="Breakdown" />
        ) : (
          <h2 className="panel-title">{title}</h2>
        )}
        <Tabs
          items={[
            { key: 'visitors', label: 'Visitors' },
            { key: 'count', label: countLabel },
          ]}
          value={metric}
          onChange={setMetric}
          label="Metric"
        />
      </div>
      <div className="panel-body">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !rows ? (
          <SkeletonRows />
        ) : !rows || rows.length === 0 ? (
          <EmptyState title="No data for this period" />
        ) : (
          <div className={loading ? 'is-loading' : undefined}>
            <BreakdownRows dimension={tab} rows={rows} metric={metric} pageHost={pageHost} onSelect={select} />
          </div>
        )}
      </div>
      <div className="panel-footer">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setViewAll(true)}
          disabled={!rows || rows.length === 0}
        >
          View all
        </button>
      </div>
      {viewAll ? (
        <ViewAllModal
          siteId={siteId}
          query={query}
          dimension={tab}
          title={title}
          metric={metric}
          pageHost={pageHost}
          countLabel={countLabel}
          onClose={() => setViewAll(false)}
          onSelect={(row) => {
            setViewAll(false);
            select(row);
          }}
        />
      ) : null}
    </section>
  );
}

/* ---------------- View all modal ---------------- */

export function ViewAllModal({
  siteId,
  query,
  dimension,
  title,
  metric: initialMetric,
  pageHost,
  countLabel,
  onClose,
  onSelect,
}: {
  siteId: string;
  query: StatsQuery;
  dimension: FilterKey;
  title: string;
  metric: RowMetric;
  pageHost: string | null;
  countLabel: string;
  onClose: () => void;
  onSelect: (row: BreakdownRow) => void;
}) {
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState<RowMetric>(initialMetric);
  const { data, error, loading, reload } = useApi(
    (signal) => api.breakdown(siteId, query, dimension, 100, signal),
    [siteId, JSON.stringify(query), dimension],
  );
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => displayValue(dimension, r.value).toLowerCase().includes(q) || (r.value ?? '').toLowerCase().includes(q));
  }, [data, search, dimension]);

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="viewall-toolbar">
        <div className="search">
          <SearchIcon />
          <input
            className="input search-input"
            type="search"
            placeholder="Search…"
            aria-label={`Search ${title}`}
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
            data-autofocus
          />
        </div>
        <Tabs
          items={[
            { key: 'visitors', label: 'Visitors' },
            { key: 'count', label: countLabel },
          ]}
          value={metric}
          onChange={setMetric}
          label="Metric"
        />
      </div>
      <div className="viewall-body">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <SkeletonRows rows={8} />
        ) : rows.length === 0 ? (
          <EmptyState title={search ? 'No matches' : 'No data for this period'} />
        ) : (
          <BreakdownRows dimension={dimension} rows={rows} metric={metric} pageHost={pageHost} onSelect={onSelect} />
        )}
      </div>
    </Modal>
  );
}

/* ---------------- Event detail modal ---------------- */

export function EventDetailModal({
  siteId,
  query,
  event,
  onClose,
  onFilter,
}: {
  siteId: string;
  query: StatsQuery;
  event: string;
  onClose: () => void;
  onFilter: () => void;
}) {
  const { data, error, loading, reload } = useApi(
    (signal) => api.eventProps(siteId, query, event, 100, signal),
    [siteId, JSON.stringify(query), event],
  );
  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<typeof data>['rows']>();
    for (const r of data?.rows ?? []) {
      const list = map.get(r.key) ?? [];
      list.push(r);
      map.set(r.key, list);
    }
    return [...map.entries()];
  }, [data]);

  return (
    <Modal
      title={
        <>
          <span className="muted">Event</span> <span className="break-all">{event}</span>
        </>
      }
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" onClick={onFilter}>
            Filter by this event
          </button>
        </>
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <SkeletonRows rows={6} />
      ) : groups.length === 0 ? (
        <EmptyState title="No properties">
          <p>
            This event was sent without properties. Pass an object as second argument, e.g.{' '}
            <code>pa.track('Signup', {'{'} plan: 'pro' {'}'})</code>.
          </p>
        </EmptyState>
      ) : (
        <div className="props">
          {groups.map(([key, rows]) => (
            <div key={key} className="props-group">
              <h3 className="props-key break-all">{key}</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Value</th>
                    <th scope="col" className="num">
                      Visitors
                    </th>
                    <th scope="col" className="num">
                      Count
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.value ?? '\u0000'}-${i}`}>
                      <td className="break-all">{r.value === null ? <span className="muted">(none)</span> : r.value}</td>
                      <td className="num">{formatNumber(r.visitors)}</td>
                      <td className="num">{formatNumber(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
