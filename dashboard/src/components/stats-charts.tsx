// Analytics charts built from the Bklit UI chart primitives (src/components/charts).
// Adds the few layers the vendored set does not ship (y-axis, time axis with
// interval-aware labels, reference bands) on top of the Bklit chart context.
import { useMemo, type CSSProperties } from 'react';
import { AreaChart, Area } from '@/components/charts/area-chart';
import { useChartStable } from '@/components/charts/chart-context';
import { Grid } from '@/components/charts/grid';
import { ChartTooltip, TooltipContent } from '@/components/charts/tooltip';
import { isLoadingChromePhase, isReferenceAreaVisiblePhase } from '@/components/charts/y-domain-utils';
import type { Interval } from '@/api/types';
import { timeZone } from '@/hooks/useStatsQuery';
import { labelIndices } from '@/lib/chart';
import { axisDateFormat, tooltipDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EmptyState } from './common';

/** Lets the page scroll vertically over a chart on touch devices (Bklit sets `none`). */
const TOUCH_STYLE: CSSProperties = { touchAction: 'pan-y' };

export interface SeriesPoint {
  t: number;
  value: number | null;
}

/* ---------------- Axis layers ---------------- */

/** Y-axis tick labels (left margin). Same tick count as the Grid rows so they line up. */
export function YAxis({ numTicks = 4, format }: { numTicks?: number; format: (v: number) => string }) {
  const { yScale, chartPhase } = useChartStable();
  if (isLoadingChromePhase(chartPhase)) return null;
  const ticks = yScale.ticks(numTicks);
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <text
          key={t}
          x={-10}
          y={yScale(t) ?? 0}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-chart-label text-[11px] tabular-nums"
        >
          {format(t)}
        </text>
      ))}
    </g>
  );
}
YAxis.displayName = 'YAxis';

/** Time axis with labels formatted for the bucket interval (hours / days / months). */
export function TimeAxis({ interval, minSpacing = 76 }: { interval: Interval; minSpacing?: number }) {
  const { data, xScale, xAccessor, innerHeight, innerWidth, chartPhase } = useChartStable();
  const fmt = useMemo(() => axisDateFormat(interval, undefined, timeZone), [interval]);
  if (isLoadingChromePhase(chartPhase) || data.length === 0) return null;
  const max = Math.max(2, Math.floor(innerWidth / minSpacing));
  const idx = labelIndices(data.length, max);
  return (
    <g aria-hidden="true">
      {idx.map((i) => {
        const d = data[i];
        if (!d) return null;
        const x = xScale(xAccessor(d)) ?? 0;
        const anchor = x < 24 ? 'start' : x > innerWidth - 24 ? 'end' : 'middle';
        return (
          <text key={i} x={x} y={innerHeight + 20} textAnchor={anchor} className="fill-chart-label text-[11px]">
            {fmt.format(xAccessor(d))}
          </text>
        );
      })}
    </g>
  );
}
TimeAxis.displayName = 'XAxis';

export interface ReferenceBand {
  /** lower bound (inclusive) */
  y1: number;
  /** upper bound; omit for "to the top of the chart" */
  y2?: number;
  /** CSS colour */
  color: string;
  /** dashed line + label at the lower bound (e.g. a threshold) */
  label?: string;
}

/**
 * Horizontal band (Recharts-style ReferenceArea) with an optional threshold line.
 * Named `ReferenceArea` so the Bklit shell renders it as an underlay (above the
 * grid, below the series, outside the reveal clip).
 */
export function ReferenceArea({ y1, y2, color, label }: ReferenceBand) {
  const { yScale, innerWidth, innerHeight, chartPhase } = useChartStable();
  if (!isReferenceAreaVisiblePhase(chartPhase)) return null;
  const [d0, d1] = yScale.domain() as [number, number];
  const lo = Math.max(y1, d0);
  const hi = Math.min(y2 ?? d1, d1);
  if (!(hi > lo)) return null;
  const top = yScale(hi) ?? 0;
  const bottom = yScale(lo) ?? innerHeight;
  const lineY = y1 > d0 ? (yScale(y1) ?? 0) : null;
  return (
    <g aria-hidden="true">
      <rect x={0} y={top} width={Math.max(0, innerWidth)} height={Math.max(0, bottom - top)} fill={color} fillOpacity={0.07} />
      {lineY !== null ? (
        <>
          <line x1={0} x2={innerWidth} y1={lineY} y2={lineY} stroke={color} strokeOpacity={0.7} strokeDasharray="4 4" />
          {label ? (
            <text x={innerWidth - 4} y={lineY - 6} textAnchor="end" className="text-[10px] font-medium" fill={color}>
              {label}
            </text>
          ) : null}
        </>
      ) : null}
    </g>
  );
}
ReferenceArea.displayName = 'ReferenceArea';

/* ---------------- Time series area chart ---------------- */

export interface TimeSeriesChartProps {
  points: readonly SeriesPoint[];
  interval: Interval;
  /** series name in the tooltip */
  valueLabel: string;
  formatValue: (v: number) => string;
  formatTick?: (v: number) => string;
  /** accessible description of the chart */
  label: string;
  loading?: boolean;
  bands?: readonly ReferenceBand[];
  /** optional second tooltip line per point (e.g. sample count) */
  note?: (t: number) => string | null;
  color?: string;
  className?: string;
  aspectRatio?: string;
}

/**
 * Bklit area chart for one metric over time: gradient area, dashed grid, y-axis,
 * interval-aware time axis and a crosshair tooltip. `null` values are left out
 * (Bklit would plot them at the top of the chart).
 */
export function TimeSeriesChart({
  points,
  interval,
  valueLabel,
  formatValue,
  formatTick = formatValue,
  label,
  loading = false,
  bands,
  note,
  color = 'var(--chart-line-primary)',
  className,
  aspectRatio = '3 / 1',
}: TimeSeriesChartProps) {
  const data = useMemo(
    () =>
      points
        .filter((p) => typeof p.value === 'number' && Number.isFinite(p.value))
        .map((p) => ({ date: new Date(p.t), t: p.t, value: p.value as number })),
    [points],
  );
  const tipFmt = useMemo(() => tooltipDateFormat(interval, undefined, timeZone), [interval]);

  if (!loading && data.length === 0) {
    return <EmptyState title="No data for this period" className={cn('min-h-56', className)} />;
  }

  return (
    <div className={cn('w-full', className)} role="img" aria-label={label}>
      <AreaChart
        data={data}
        aspectRatio={aspectRatio}
        margin={{ top: 16, right: 12, bottom: 32, left: 48 }}
        status={loading && data.length === 0 ? 'loading' : 'ready'}
        animationDuration={900}
        style={TOUCH_STYLE}
        className="min-h-56"
      >
        <Grid horizontal numTicksRows={4} strokeDasharray="3,4" fadeHorizontal={false} />
        {(bands ?? []).map((b) => (
          <ReferenceArea key={`${b.y1}-${b.y2 ?? 'top'}`} {...b} />
        ))}
        <YAxis numTicks={4} format={formatTick} />
        <TimeAxis interval={interval} />
        <Area dataKey="value" fill={color} stroke={color} fillOpacity={0.28} strokeWidth={2} />
        <ChartTooltip
          showDatePill={false}
          content={({ point }) => {
            const t = typeof point.t === 'number' ? point.t : 0;
            const v = typeof point.value === 'number' ? formatValue(point.value) : '–';
            const extra = note?.(t);
            return (
              <TooltipContent title={tipFmt.format(t)} rows={[{ color, label: valueLabel, value: v }]}>
                {extra ? <div className="text-xs text-chart-tooltip-muted">{extra}</div> : null}
              </TooltipContent>
            );
          }}
        />
      </AreaChart>
    </div>
  );
}

/* ---------------- Sparkline ---------------- */

/** Minimal Bklit area sparkline (no axes, no interaction). */
export function Sparkline({
  values,
  label,
  className,
  color = 'var(--chart-line-primary)',
}: {
  values: readonly number[];
  label: string;
  className?: string;
  color?: string;
}) {
  const data = useMemo(() => {
    const base = Date.UTC(2000, 0, 1);
    return values.map((v, i) => ({ date: new Date(base + i * 86_400_000), value: Number.isFinite(v) ? v : 0 }));
  }, [values]);
  const flat = data.length < 2;
  return (
    <div className={cn('pointer-events-none h-10 w-full', className)} role="img" aria-label={label}>
      {flat ? (
        <div className="flex h-full items-end">
          <div className="h-px w-full bg-chart-grid" />
        </div>
      ) : (
        <AreaChart
          data={data}
          aspectRatio="auto"
          className="h-full"
          margin={{ top: 3, right: 1, bottom: 1, left: 1 }}
          animationDuration={700}
          style={{ height: '100%', aspectRatio: 'auto' }}
        >
          <Area dataKey="value" fill={color} stroke={color} fillOpacity={0.22} strokeWidth={1.5} showHighlight={false} />
        </AreaChart>
      )}
    </div>
  );
}
