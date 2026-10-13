// Building blocks of the site analytics screen (shadcn Card / Tabs / Dialog).
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLinkIcon, ListIcon, SearchIcon, XIcon } from 'lucide-react';
import { api } from '@/api/client';
import { FILTER_KEYS, type BreakdownRow, type FilterKey, type Filters, type StatsQuery } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState, ErrorState, LiveDot, SkeletonRows } from '@/components/common';
import { useApi } from '@/hooks/useApi';
import { usePageVisible } from '@/hooks/usePageVisible';
import { DIMENSION_LABELS, displayValue, filterValueFor, rowHref, valuePrefix } from '@/lib/dimensions';
import { formatCompact, formatNumber } from '@/lib/format';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

/* ---------------- Live indicator ---------------- */

export const REALTIME_INTERVAL_MS = 30_000;

/** "N online" pill (visitors in the last 5 minutes); links to the Live tab. */
export function LiveIndicator({ siteId, tz, href }: { siteId: string; tz: string; href?: string }) {
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

  const text = count === null ? '– online' : `${formatNumber(count)} online`;
  const cls =
    'inline-flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-sm font-medium whitespace-nowrap tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';
  const content = (
    <>
      <LiveDot active={!!count} />
      <span>{text}</span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <Link to={href} className={cn(cls, 'hover:bg-muted')} aria-live="polite" />
          ) : (
            <span className={cls} aria-live="polite" tabIndex={0} />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent>Visitors in the last 5 minutes</TooltipContent>
    </Tooltip>
  );
}

/* ---------------- Filter chips ---------------- */

export function FilterChip({ label, value, onRemove }: { label: string; value: ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background pr-0.5 pl-2.5 text-xs shadow-xs dark:bg-input/30">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="shrink-0 text-muted-foreground/70">is</span>
      <span className="chip-value bidi-isolate min-w-0 truncate font-medium">{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={`Remove ${label} filter`}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </span>
  );
}

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
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {active.map((k) => {
        const raw = filters[k] ?? '';
        const value = raw === '' ? null : raw;
        const prefix = valuePrefix(k, value);
        return (
          <FilterChip
            key={k}
            label={DIMENSION_LABELS[k]}
            value={`${prefix ? `${prefix} ` : ''}${displayValue(k, value)}`}
            onRemove={() => onRemove(k)}
          />
        );
      })}
      {active.length > 1 ? (
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear all
        </Button>
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
  siteDomains,
  onSelect,
}: {
  dimension: FilterKey;
  rows: readonly BreakdownRow[];
  metric: RowMetric;
  pageHost: string | null;
  /** the site's configured domains; hostname rows only link to these */
  siteDomains: readonly string[];
  onSelect: (row: BreakdownRow) => void;
}) {
  const sorted = useMemo(
    () => (metric === 'visitors' ? rows : [...rows].sort((a, b) => b.count - a.count)),
    [rows, metric],
  );
  const max = Math.max(1, ...sorted.map((r) => r[metric]));
  return (
    <ul className="flex flex-col gap-1">
      {sorted.map((row, i) => {
        const label = displayValue(dimension, row.value);
        const prefix = valuePrefix(dimension, row.value);
        const href = rowHref(dimension, row.value, pageHost, siteDomains);
        const v = row[metric];
        const pct = Math.max(0, Math.min(100, (v / max) * 100));
        return (
          <li key={`${row.value ?? '\u0000null'}-${i}`} className="group/row flex h-8 items-center gap-2">
            <button
              type="button"
              data-slot="breakdown-row"
              className="relative flex h-full min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => onSelect(row)}
              title={label}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded-md bg-chart-1/12 transition-[width] duration-500 ease-out dark:bg-chart-1/15"
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex min-w-0 items-center gap-2">
                {prefix ? (
                  <span className="shrink-0 text-base leading-none" aria-hidden="true">
                    {prefix}
                  </span>
                ) : null}
                <span data-slot="breakdown-label" className={cn('bidi-isolate truncate', row.value === null && 'text-muted-foreground')}>
                  {label}
                </span>
              </span>
            </button>
            {href ? (
              <a
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:opacity-100"
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={`Open ${label} in a new tab`}
                title="Open in a new tab"
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums" title={formatNumber(v)}>
              {formatCompact(v)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- Metric switch ---------------- */

function MetricSwitch({ metric, onMetric, countLabel }: { metric: RowMetric; onMetric: (m: RowMetric) => void; countLabel: string }) {
  const options: Array<[RowMetric, string]> = [
    ['visitors', 'Visitors'],
    ['count', countLabel],
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label="Metric">
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={metric === key}
          className={cn(
            'h-5 rounded-[5px] px-1.5 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            metric === key && 'bg-background text-foreground shadow-xs dark:bg-input/40',
          )}
          onClick={() => onMetric(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function ColumnsHeader({
  label,
  metric,
  onMetric,
  countLabel,
}: {
  label: string;
  metric: RowMetric;
  onMetric: (m: RowMetric) => void;
  countLabel: string;
}) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 px-2 text-xs font-medium text-muted-foreground">
      <span className="truncate">{label}</span>
      <MetricSwitch metric={metric} onMetric={onMetric} countLabel={countLabel} />
    </div>
  );
}

/* ---------------- Panel ---------------- */

export interface PanelTab {
  key: FilterKey;
  label: string;
}

/** Tab strip that scrolls horizontally when it does not fit (narrow panels, phones). */
export function PanelTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: ReadonlyArray<{ key: K; label: string }>;
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as K)} className="min-w-0">
      <TabsList variant="line" aria-label={label} className="scrollbar-none -mx-1 h-8 w-[calc(100%+0.5rem)] justify-start overflow-x-auto px-1">
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key} className="flex-none px-2 text-[13px]">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

export function BreakdownPanel({
  siteId,
  query,
  tabs,
  pageHost,
  siteDomains,
  countLabel = 'Views',
  onFilter,
  onSelectRow,
  extraViews,
}: {
  siteId: string;
  query: StatsQuery;
  tabs: readonly PanelTab[];
  pageHost: string | null;
  siteDomains: readonly string[];
  countLabel?: string;
  onFilter: (key: FilterKey, value: string) => void;
  /** overrides the default click behaviour (filtering) */
  onSelectRow?: (key: FilterKey, row: BreakdownRow) => void;
  /** optional alternative visualisation (e.g. a map) toggled from the header */
  extraViews?: { icon: ReactNode; label: string; render: (rows: readonly BreakdownRow[]) => ReactNode };
}) {
  const [tab, setTab] = useState<FilterKey>(tabs[0]!.key);
  const [metric, setMetric] = useState<RowMetric>('visitors');
  const [viewAll, setViewAll] = useState(false);
  const [alt, setAlt] = useState(false);
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
    <Card className="gap-0 py-0" aria-label={tabs.map((t) => t.label).join(', ')} role="region">
      <CardHeader className="flex min-h-12 items-center gap-2 border-b px-4 py-0 [.border-b]:pb-0">
        <div className="flex min-w-0 flex-1 items-center">
          {tabs.length > 1 ? (
            <PanelTabs tabs={tabs} value={tab} onChange={setTab} label="Breakdown" />
          ) : (
            <h2 className="text-sm font-medium">{title}</h2>
          )}
        </div>
        {extraViews ? (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={!alt}
              aria-label="List"
              className={cn('inline-flex size-6 items-center justify-center rounded-[5px] text-muted-foreground hover:text-foreground', !alt && 'bg-background text-foreground shadow-xs dark:bg-input/40')}
              onClick={() => setAlt(false)}
            >
              <ListIcon className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={alt}
              aria-label={extraViews.label}
              className={cn('inline-flex size-6 items-center justify-center rounded-[5px] text-muted-foreground hover:text-foreground [&_svg]:size-3.5', alt && 'bg-background text-foreground shadow-xs dark:bg-input/40')}
              onClick={() => setAlt(true)}
            >
              {extraViews.icon}
            </button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-2 pt-2 pb-2">
        <ColumnsHeader label={DIMENSION_LABELS[tab]} metric={metric} onMetric={setMetric} countLabel={countLabel} />
        <div className="min-h-24 flex-1 lg:min-h-[21rem]">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading && !rows ? (
            <SkeletonRows rows={6} className="px-2 pt-1" />
          ) : !rows || rows.length === 0 ? (
            <EmptyState title="No data for this period" className="py-16" />
          ) : alt && extraViews ? (
            extraViews.render(rows)
          ) : (
            <div className={cn('transition-opacity', loading && 'opacity-60')}>
              <BreakdownRows
                dimension={tab}
                rows={rows}
                metric={metric}
                pageHost={pageHost}
                siteDomains={siteDomains}
                onSelect={select}
              />
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter className="justify-end border-t bg-transparent px-2 py-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={() => setViewAll(true)} disabled={!rows || rows.length === 0}>
          View all
        </Button>
      </CardFooter>
      {viewAll ? (
        <ViewAllDialog
          siteId={siteId}
          query={query}
          dimension={tab}
          title={title}
          metric={metric}
          pageHost={pageHost}
          siteDomains={siteDomains}
          countLabel={countLabel}
          onClose={() => setViewAll(false)}
          onSelect={(row) => {
            setViewAll(false);
            select(row);
          }}
        />
      ) : null}
    </Card>
  );
}

/* ---------------- View all dialog ---------------- */

export function ViewAllDialog({
  siteId,
  query,
  dimension,
  title,
  metric: initialMetric,
  pageHost,
  siteDomains,
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
  siteDomains: readonly string[];
  countLabel: string;
  onClose: () => void;
  onSelect: (row: BreakdownRow) => void;
}) {
  const [search, setSearch] = useState('');
  const [metric, setMetric] = useState<RowMetric>(initialMetric);
  const searchId = useId();
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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Top 100 for the selected period. Click a row to filter.</DialogDescription>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id={searchId}
            type="search"
            placeholder="Search…"
            aria-label={`Search ${title}`}
            value={search}
            maxLength={200}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
          />
        </InputGroup>
        <ColumnsHeader label={DIMENSION_LABELS[dimension]} metric={metric} onMetric={setMetric} countLabel={countLabel} />
        <div className="-mx-1 min-h-48 overflow-y-auto px-1">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading && !data ? (
            <SkeletonRows rows={8} />
          ) : rows.length === 0 ? (
            <EmptyState title={search ? 'No matches' : 'No data for this period'} />
          ) : (
            <BreakdownRows
              dimension={dimension}
              rows={rows}
              metric={metric}
              pageHost={pageHost}
              siteDomains={siteDomains}
              onSelect={onSelect}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Event detail dialog ---------------- */

export function EventDetailDialog({
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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="leading-snug break-all">
            <span className="text-muted-foreground">Event</span> <bdi className="bidi-isolate">{displayText(event)}</bdi>
          </DialogTitle>
          <DialogDescription>Custom properties sent with this event.</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-32 overflow-y-auto px-1">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading && !data ? (
            <SkeletonRows rows={6} />
          ) : groups.length === 0 ? (
            <EmptyState title="No properties">
              <p>
                This event was sent without properties. Pass an object as second argument, e.g.{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">pa.track('Signup', {'{'} plan: 'pro' {'}'})</code>.
              </p>
            </EmptyState>
          ) : (
            <div className="flex flex-col gap-5" data-slot="event-props">
              {groups.map(([key, rows]) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-medium break-all" data-slot="event-prop-key">
                    <bdi className="bidi-isolate">{displayText(key)}</bdi>
                  </h3>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Value</TableHead>
                          <TableHead className="w-24 text-right">Visitors</TableHead>
                          <TableHead className="w-24 text-right">Count</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((r, i) => (
                          <TableRow key={`${r.value ?? '\u0000'}-${i}`}>
                            <TableCell className="max-w-0 whitespace-normal break-all">
                              {r.value === null ? (
                                <span className="text-muted-foreground">(none)</span>
                              ) : (
                                <bdi className="bidi-isolate">{displayText(r.value)}</bdi>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(r.visitors)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={onFilter}>
            Filter by this event
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
