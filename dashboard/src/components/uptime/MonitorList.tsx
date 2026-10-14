import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRightIcon, FilterXIcon, SearchIcon, ShieldCheckIcon } from 'lucide-react';
import type { Site } from '@/api/types';
import type { DisplayStatus, Monitor } from '@/api/uptime';
import { EmptyState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { MonitorActionsMenu, type MonitorActionHandlers } from './actions';
import { HeartbeatBar, type BeatLike } from './bars';
import {
  displayStatus,
  filterMonitors,
  formatLatency,
  formatUptime,
  hasFilters,
  monitorTree,
  STATUS_LABELS,
  typeLabel,
  uptimeTone,
  type MonitorFilters,
} from './lib';
import { StatusDot, TagChip } from './status';

const STATUS_FILTERS: DisplayStatus[] = ['up', 'down', 'pending', 'maintenance', 'paused', 'unknown'];

/** Filter state kept in the URL (`q`, `status`, `site`, `tag`, `type`). */
export function useMonitorFilters(): [MonitorFilters, (patch: Partial<MonitorFilters>) => void, () => void] {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const filters = useMemo<MonitorFilters>(() => {
    const p = new URLSearchParams(key);
    const status = p.get('status');
    return {
      q: (p.get('q') ?? '').slice(0, 200),
      status: (STATUS_FILTERS as readonly string[]).includes(status ?? '') ? (status as DisplayStatus) : '',
      siteId: p.get('site') ?? '',
      tag: p.get('tag') ?? '',
      type: p.get('type') ?? '',
    };
  }, [key]);
  const set = (patch: Partial<MonitorFilters>) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        const map: Record<string, keyof MonitorFilters> = { q: 'q', status: 'status', site: 'siteId', tag: 'tag', type: 'type' };
        for (const [param, k] of Object.entries(map)) {
          if (!(k in patch)) continue;
          const v = patch[k];
          if (v) next.set(param, String(v));
          else next.delete(param);
        }
        return next;
      },
      { replace: true },
    );
  const clear = () => set({ q: '', status: '', siteId: '', tag: '', type: '' });
  return [filters, set, clear];
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  allLabel: string;
  className?: string;
}) {
  return (
    <Select<string> value={value || '__all'} onValueChange={(v) => onChange(!v || v === '__all' ? '' : v)}>
      <SelectTrigger aria-label={label} className={cn('min-w-0 bg-background', className)}>
        <SelectValue>{(v: string) => (v === '__all' ? allLabel : (options.find((o) => o.value === v)?.label ?? allLabel))}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectItem value="__all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className="bidi-isolate truncate">{o.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface MonitorListProps extends MonitorActionHandlers {
  monitors: readonly Monitor[];
  beats: ReadonlyMap<string, BeatLike[]>;
  /** When given (and more than one), rows show the site and a site filter is offered. */
  sites?: readonly Site[];
  typeLabels?: Readonly<Record<string, string>>;
  canManage: boolean;
  /** Rendered instead of the list when there are no monitors at all. */
  empty?: ReactNode;
  toolbarEnd?: ReactNode;
}

export function MonitorList({ monitors, beats, sites, typeLabels, canManage, empty, toolbarEnd, ...handlers }: MonitorListProps) {
  const [filters, setFilters, clearFilters] = useMonitorFilters();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const siteNames = useMemo(() => new Map((sites ?? []).map((s) => [s.id, s.name])), [sites]);
  const multiSite = (sites?.length ?? 0) > 1;

  const tagOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const mon of monitors) for (const t of mon.tags) m.set(t.uid, displayText(t.name));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [monitors]);
  const typeOptions = useMemo(
    () => [...new Set(monitors.map((m) => m.type))].map((t) => ({ value: t, label: typeLabel(t, typeLabels) })).sort((a, b) => a.label.localeCompare(b.label)),
    [monitors, typeLabels],
  );
  const effective: MonitorFilters = { ...filters, siteId: multiSite ? filters.siteId : '' };
  const filtering = hasFilters(effective);
  const filtered = useMemo(() => filterMonitors(monitors, effective), [monitors, effective.q, effective.status, effective.siteId, effective.tag, effective.type]); // eslint-disable-line react-hooks/exhaustive-deps
  // tree only when not filtering (filtered results are shown flat)
  const rows = useMemo(
    () => (filtering ? filtered.map((m) => ({ monitor: m, depth: 0, childCount: 0 })) : monitorTree(filtered, collapsed)),
    [filtering, filtered, collapsed],
  );

  if (monitors.length === 0 && empty) return <>{empty}</>;

  const toggle = (uid: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="search">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={filters.q ?? ''}
            onChange={(e) => setFilters({ q: e.target.value })}
            placeholder="Search name, URL, tag…"
            aria-label="Search monitors"
            className="bg-background pl-8 dark:bg-input/30"
            maxLength={200}
          />
        </div>
        <FilterSelect
          label="Status"
          value={filters.status ?? ''}
          onChange={(v) => setFilters({ status: v as DisplayStatus | '' })}
          allLabel="All statuses"
          options={STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
          className="flex-1 sm:w-36 sm:flex-none"
        />
        {multiSite ? (
          <FilterSelect
            label="Site"
            value={filters.siteId ?? ''}
            onChange={(v) => setFilters({ siteId: v })}
            allLabel="All sites"
            options={(sites ?? []).map((s) => ({ value: s.id, label: displayText(s.name) }))}
            className="flex-1 sm:w-40 sm:flex-none"
          />
        ) : null}
        {tagOptions.length > 0 ? (
          <FilterSelect label="Tag" value={filters.tag ?? ''} onChange={(v) => setFilters({ tag: v })} allLabel="All tags" options={tagOptions} className="flex-1 sm:w-36 sm:flex-none" />
        ) : null}
        {typeOptions.length > 1 ? (
          <FilterSelect label="Type" value={filters.type ?? ''} onChange={(v) => setFilters({ type: v })} allLabel="All types" options={typeOptions} className="flex-1 sm:w-36 sm:flex-none" />
        ) : null}
        {filtering ? (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            <FilterXIcon aria-hidden="true" />
            Clear
          </Button>
        ) : null}
        {toolbarEnd}
      </div>

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="hidden items-center gap-4 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:flex" aria-hidden="true">
          <span className="flex-1">Monitor</span>
          <span className="w-[clamp(9rem,24vw,17rem)]">Recent checks</span>
          <span className="w-16 text-right">24 h</span>
          <span className="w-16 text-right">Response</span>
          <span className="w-14 text-right">Cert</span>
          <span className="w-7" />
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No monitors match" icon={<SearchIcon />}>
            <p>Try another search or clear the filters.</p>
            <Button type="button" variant="outline" className="mt-3" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyState>
        ) : (
          <ul className="divide-y" aria-label="Monitors">
            {rows.map(({ monitor: m, depth, childCount }) => (
              <MonitorRow
                key={m.uid}
                monitor={m}
                depth={depth}
                childCount={childCount}
                collapsed={collapsed.has(m.uid)}
                onToggle={() => toggle(m.uid)}
                beats={beats.get(m.uid)}
                siteName={multiSite ? siteNames.get(m.siteId) : undefined}
                typeLabels={typeLabels}
                canManage={canManage}
                {...handlers}
              />
            ))}
          </ul>
        )}
      </div>
      <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
        {filtering ? `${filtered.length} of ${monitors.length} monitors` : `${monitors.length} ${monitors.length === 1 ? 'monitor' : 'monitors'}`}
      </p>
    </div>
  );
}

function CertCell({ m }: { m: Monitor }) {
  const d = m.tls?.daysLeft ?? null;
  if (!m.tls || d === null) return <span className="text-muted-foreground/60">–</span>;
  const tone = !m.tls.valid || d < 7 ? 'text-poor-text' : d < 21 ? 'text-warn-text' : 'text-muted-foreground';
  return (
    <span className={cn('inline-flex items-center gap-1 tabular-nums', tone)} title={m.tls.valid ? `Certificate valid for ${d} more days` : 'Certificate invalid'}>
      <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
      {m.tls.valid ? `${d}d` : 'invalid'}
    </span>
  );
}

function MonitorRow({
  monitor: m,
  depth,
  childCount,
  collapsed,
  onToggle,
  beats,
  siteName,
  typeLabels,
  canManage,
  ...handlers
}: MonitorActionHandlers & {
  monitor: Monitor;
  depth: number;
  childCount: number;
  collapsed: boolean;
  onToggle: () => void;
  beats: BeatLike[] | undefined;
  siteName?: string;
  typeLabels?: Readonly<Record<string, string>>;
  canManage: boolean;
}) {
  const status = displayStatus(m);
  const href = `/monitors/${encodeURIComponent(m.uid)}`;
  const target = m.target ? displayText(m.target) : null;
  const uptime = (
    <span className={cn('font-medium tabular-nums', uptimeTone(m.uptime24h))} title="Uptime, last 24 hours">
      {formatUptime(m.uptime24h)}
    </span>
  );
  const indent = depth > 0 ? `${depth * 1.25}rem` : undefined;
  return (
    <li className="group/row relative flex flex-col gap-2.5 px-4 py-3 transition-colors hover:bg-muted/40 md:flex-row md:items-center md:gap-4" data-status={status}>
      <div className="flex min-w-0 flex-1 items-center gap-3" style={indent ? { paddingLeft: indent } : undefined}>
        {childCount > 0 ? (
          <button
            type="button"
            className="relative z-10 -ml-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${displayText(m.name)}`}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <ChevronRightIcon className={cn('size-4 transition-transform', !collapsed && 'rotate-90')} aria-hidden="true" />
          </button>
        ) : null}
        <StatusDot status={status} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to={href}
              className={cn(
                'bidi-isolate truncate font-medium outline-none after:absolute after:inset-0 after:content-[""] focus-visible:underline',
                status === 'paused' && 'text-muted-foreground',
              )}
            >
              {displayText(m.name)}
            </Link>
            <span className="sr-only">, {STATUS_LABELS[status]}</span>
            {childCount > 0 ? <span className="shrink-0 rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{childCount}</span> : null}
            <span className="hidden min-w-0 items-center gap-1 lg:flex">
              {m.tags.slice(0, 3).map((t) => (
                <TagChip key={`${t.uid}:${t.value}`} name={t.name} value={t.value} color={t.color} />
              ))}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{typeLabel(m.type, typeLabels)}</span>
            {target ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="bidi-isolate truncate" title={target}>
                  {target}
                </span>
              </>
            ) : null}
            {siteName ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="bidi-isolate shrink-0 truncate">{displayText(siteName)}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 md:hidden">
          {uptime}
          <div className="relative z-10">
            <MonitorActionsMenu monitor={m} canManage={canManage} {...handlers} />
          </div>
        </div>
      </div>
      <div className="relative z-10 flex items-center gap-3 md:contents">
        <HeartbeatBar beats={beats ?? []} slots={50} className="min-w-0 flex-1 md:w-[clamp(9rem,24vw,17rem)] md:flex-none" label={`Recent checks of ${displayText(m.name)}`} />
        <span className="flex w-[5.5rem] shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground md:hidden">
          <span className="tabular-nums">{m.active ? formatLatency(m.state.latencyMs) : ''}</span>
          {m.tls ? <CertCell m={m} /> : null}
        </span>
      </div>
      <span className="hidden w-16 text-right text-sm md:block">{uptime}</span>
      <span className="hidden w-16 text-right text-sm text-muted-foreground tabular-nums md:block">{m.active ? formatLatency(m.state.latencyMs) : '–'}</span>
      <span className="hidden w-14 text-right text-xs md:block">
        <CertCell m={m} />
      </span>
      <div className="relative z-10 hidden w-7 justify-end md:flex">
        <MonitorActionsMenu monitor={m} canManage={canManage} {...handlers} />
      </div>
    </li>
  );
}
