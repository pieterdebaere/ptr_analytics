// Response-time chart (Bklit area): average latency line, min–max band and shaded
// down / maintenance ranges. Built from the vendored chart primitives (not modified).
import { useMemo, type CSSProperties } from 'react';
import { AreaChart, Area } from '@/components/charts/area-chart';
import { useChartStable } from '@/components/charts/chart-context';
import { Grid } from '@/components/charts/grid';
import { ChartTooltip, TooltipContent } from '@/components/charts/tooltip';
import { isLoadingChromePhase, isReferenceAreaVisiblePhase } from '@/components/charts/y-domain-utils';
import type { HeartbeatInterval, HeartbeatPoint } from '@/api/uptime';
import { EmptyState } from '@/components/common';
import { YAxis } from '@/components/stats-charts';
import { Skeleton } from '@/components/ui/skeleton';
import { labelIndices } from '@/lib/chart';
import { cn } from '@/lib/utils';
import { formatLatency } from './lib';

const TOUCH_STYLE: CSSProperties = { touchAction: 'pan-y' };
const BAND_COLOR = 'var(--chart-line-primary)';
const MAX_COLOR = 'color-mix(in oklch, var(--chart-line-primary) 45%, transparent)';

export interface StatusRange {
  start: number;
  end: number;
  kind: 'down' | 'maintenance';
}

const BUCKET_MS: Record<HeartbeatInterval, number> = { raw: 60_000, hour: 3_600_000, day: 86_400_000 };

/** Median gap between consecutive points (fallback: the interval's bucket size). */
function typicalStep(points: readonly HeartbeatPoint[], interval: HeartbeatInterval): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i]!.t - points[i - 1]!.t);
  if (gaps.length === 0) return BUCKET_MS[interval];
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]! || BUCKET_MS[interval];
}

/**
 * Contiguous DOWN (status 0) and MAINTENANCE (3) ranges. A point covers [t, next t)
 * (the last one a typical step); adjacent ranges of the same kind are merged.
 */
export function statusRanges(points: readonly HeartbeatPoint[], interval: HeartbeatInterval): StatusRange[] {
  const step = typicalStep(points, interval);
  const out: StatusRange[] = [];
  points.forEach((p, i) => {
    const kind = p.status === 0 ? 'down' : p.status === 3 ? 'maintenance' : null;
    if (!kind) return;
    const next = points[i + 1];
    const end = next ? Math.min(next.t, p.t + step * 3) : p.t + step;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.end >= p.t) last.end = Math.max(last.end, end);
    else out.push({ start: p.t, end, kind });
  });
  return out;
}

/** Shaded vertical ranges; named ReferenceArea so the Bklit shell renders it as an underlay. */
function StatusRangesLayer({ ranges }: { ranges: readonly StatusRange[] }) {
  const { xScale, innerWidth, innerHeight, chartPhase } = useChartStable();
  if (!isReferenceAreaVisiblePhase(chartPhase)) return null;
  return (
    <g aria-hidden="true">
      {ranges.map((r) => {
        const x0 = Math.max(0, xScale(new Date(r.start)) ?? 0);
        const x1 = Math.min(innerWidth, xScale(new Date(r.end)) ?? innerWidth);
        const w = Math.max(2, x1 - x0);
        if (x0 > innerWidth || x1 < 0) return null;
        const color = r.kind === 'down' ? 'var(--poor)' : 'var(--chart-1)';
        return (
          <g key={`${r.kind}-${r.start}`}>
            <rect x={x0} y={0} width={w} height={innerHeight} fill={color} fillOpacity={r.kind === 'down' ? 0.13 : 0.1} />
            <rect x={x0} y={innerHeight - 3} width={w} height={3} fill={color} fillOpacity={0.85} rx={1} />
          </g>
        );
      })}
    </g>
  );
}
StatusRangesLayer.displayName = 'ReferenceArea';

/** Min–max latency band between the `min` and `max` keys of the chart data. */
function LatencyBand() {
  const { data, xScale, yScale, chartPhase } = useChartStable();
  if (!isReferenceAreaVisiblePhase(chartPhase) || data.length < 2) return null;
  const pts = data.map((d) => ({
    x: xScale(d.date as Date) ?? 0,
    lo: yScale(typeof d.min === 'number' ? d.min : 0) ?? 0,
    hi: yScale(typeof d.max === 'number' ? d.max : 0) ?? 0,
  }));
  const r = (n: number) => Math.round(n * 10) / 10;
  const path =
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${r(p.x)},${r(p.hi)}`).join('') +
    pts
      .slice()
      .reverse()
      .map((p) => `L${r(p.x)},${r(p.lo)}`)
      .join('') +
    'Z';
  return <path d={path} fill={BAND_COLOR} fillOpacity={0.1} aria-hidden="true" />;
}
LatencyBand.displayName = 'ReferenceArea';

function spanFormatter(spanMs: number): Intl.DateTimeFormat {
  if (spanMs <= 10 * 60_000) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  if (spanMs <= 36 * 3_600_000) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
}

function TimeAxis({ minSpacing = 84 }: { minSpacing?: number }) {
  const { data, xScale, innerHeight, innerWidth, chartPhase } = useChartStable();
  const first = data[0]?.date as Date | undefined;
  const last = data[data.length - 1]?.date as Date | undefined;
  const fmt = useMemo(() => spanFormatter(first && last ? last.getTime() - first.getTime() : 0), [first, last]);
  if (isLoadingChromePhase(chartPhase) || data.length === 0) return null;
  const idx = labelIndices(data.length, Math.max(2, Math.floor(innerWidth / minSpacing)));
  return (
    <g aria-hidden="true">
      {idx.map((i) => {
        const d = data[i];
        if (!d) return null;
        const x = xScale(d.date as Date) ?? 0;
        const anchor = x < 24 ? 'start' : x > innerWidth - 24 ? 'end' : 'middle';
        return (
          <text key={i} x={x} y={innerHeight + 20} textAnchor={anchor} className="fill-chart-label text-[11px]">
            {fmt.format(d.date as Date)}
          </text>
        );
      })}
    </g>
  );
}
TimeAxis.displayName = 'XAxis';

const tipFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ResponseTimeChart({
  points,
  interval,
  loading = false,
  className,
}: {
  points: readonly HeartbeatPoint[];
  interval: HeartbeatInterval;
  loading?: boolean;
  className?: string;
}) {
  const data = useMemo(
    () =>
      points
        .filter((p) => typeof p.latencyMs === 'number' && Number.isFinite(p.latencyMs))
        .map((p) => {
          const avg = p.latencyMs as number;
          return {
            date: new Date(p.t),
            t: p.t,
            avg,
            min: Math.min(avg, p.latencyMin ?? avg),
            max: Math.max(avg, p.latencyMax ?? avg),
            upRatio: p.upRatio,
            status: p.status,
          };
        }),
    [points],
  );
  const ranges = useMemo(() => statusRanges(points, interval), [points, interval]);
  const hasBand = interval !== 'raw' && data.some((d) => d.max > d.min);

  if (data.length < 2) {
    if (loading) return <Skeleton className={cn('min-h-56 w-full rounded-lg opacity-60', className)} style={{ aspectRatio: '3 / 1' }} aria-busy="true" aria-label="Loading" />;
    return <EmptyState title="No response times for this period" className={cn('min-h-56', className)} />;
  }

  return (
    <div className={cn('w-full', className)} role="img" aria-label="Response time over time">
      <AreaChart data={data} aspectRatio="3 / 1" margin={{ top: 16, right: 12, bottom: 32, left: 56 }} animationDuration={800} style={TOUCH_STYLE} className="min-h-56">
        <Grid horizontal numTicksRows={4} strokeDasharray="3,4" fadeHorizontal={false} />
        {ranges.length > 0 ? <StatusRangesLayer ranges={ranges} /> : null}
        {hasBand ? <LatencyBand /> : null}
        <YAxis numTicks={4} format={(v) => formatLatency(v)} />
        <TimeAxis />
        {hasBand ? <Area dataKey="max" fill={MAX_COLOR} stroke={MAX_COLOR} fillOpacity={0} strokeWidth={1} showLine={false} showHighlight={false} /> : null}
        <Area dataKey="avg" fill="var(--chart-line-primary)" stroke="var(--chart-line-primary)" fillOpacity={0.22} strokeWidth={2} />
        <ChartTooltip
          showDatePill={false}
          content={({ point }) => {
            const t = typeof point.t === 'number' ? point.t : 0;
            const rows = [{ color: 'var(--chart-line-primary)', label: interval === 'raw' ? 'Response' : 'Average', value: formatLatency(point.avg as number) }];
            if (hasBand) rows.push({ color: MAX_COLOR, label: 'Min – max', value: `${formatLatency(point.min as number)} – ${formatLatency(point.max as number)}` });
            const up = typeof point.upRatio === 'number' && interval !== 'raw' ? point.upRatio : null;
            return (
              <TooltipContent title={tipFmt.format(t)} rows={rows}>
                {up !== null && up < 1 ? <div className="text-xs text-chart-tooltip-muted">Uptime {(up * 100).toFixed(2)}%</div> : null}
                {point.status === 0 ? <div className="text-xs font-medium text-poor">Down</div> : point.status === 3 ? <div className="text-xs text-chart-tooltip-muted">Maintenance</div> : null}
              </TooltipContent>
            );
          }}
        />
      </AreaChart>
      {ranges.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
          {ranges.some((r) => r.kind === 'down') ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-3 rounded-sm bg-poor/30 ring-1 ring-poor/50" aria-hidden="true" /> Down
            </span>
          ) : null}
          {ranges.some((r) => r.kind === 'maintenance') ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-3 rounded-sm bg-chart-1/25 ring-1 ring-chart-1/50" aria-hidden="true" /> Maintenance
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
