/**
 * Bklit chart demos with fake data. Lazy-loaded (React.lazy) so the chart code
 * stays out of the initial bundle and is only fetched near the viewport.
 */
import { useMemo, useRef, useState } from 'react';
import { AreaChart, Area } from '@/components/charts/area-chart';
import { Bar } from '@/components/charts/bar';
import { BarChart } from '@/components/charts/bar-chart';
import { BarYAxis } from '@/components/charts/bar-y-axis';
import { Gauge } from '@/components/charts/gauge';
import { Grid } from '@/components/charts/grid';
import { Legend, LegendItem, LegendLabel, LegendMarker, LegendValue } from '@/components/charts/legend';
import { LiveLine } from '@/components/charts/live-line';
import { LiveLineChart } from '@/components/charts/live-line-chart';
import { LiveXAxis } from '@/components/charts/live-x-axis';
import { Ring } from '@/components/charts/ring';
import { RingChart } from '@/components/charts/ring-chart';
import { ChartTooltip } from '@/components/charts/tooltip';
import { XAxis } from '@/components/charts/x-axis';
import { cn } from '@/lib/utils';
import { useIsVisible } from '~/hooks/useInView';
import { useReducedMotion } from '~/hooks/useReducedMotion';
import { DEVICES, REAL_EXPERIENCE_SCORE, TOP_PAGES, VITALS, type VitalRating, visitorSeries } from './data';
import { useLiveVisitors } from './useLiveVisitors';

const intFmt = new Intl.NumberFormat('en-US');
/** Let vertical page scrolling pass through the charts on touch devices. */
const SCROLLABLE = { touchAction: 'pan-y' } as const;

/* ------------------------------------------------------------------ */

export function VisitorsChart() {
  const data = useMemo(() => visitorSeries(30), []);
  return (
    <AreaChart
      data={data}
      aspectRatio="2.4 / 1"
      margin={{ top: 16, right: 8, bottom: 32, left: 8 }}
      className="min-h-[190px]"
      style={SCROLLABLE}
    >
      <Grid horizontal numTicksRows={4} hideHorizontalEdgeLines />
      <Area dataKey="pageviews" fill="var(--chart-line-secondary)" fillOpacity={0.05} strokeWidth={1.5} />
      <Area dataKey="visitors" fill="var(--chart-line-primary)" fillOpacity={0.35} strokeWidth={2} />
      <XAxis numTicks={5} />
      <ChartTooltip
        rows={(p) => [
          { color: 'var(--chart-line-primary)', label: 'Visitors', value: Number(p.visitors) },
          { color: 'var(--chart-line-secondary)', label: 'Page views', value: Number(p.pageviews) },
        ]}
      />
    </AreaChart>
  );
}

/* ------------------------------------------------------------------ */

export function TopPagesChart() {
  const data = useMemo(() => TOP_PAGES.map((p) => ({ name: p.name, views: p.views })), []);
  return (
    <BarChart
      data={data}
      orientation="horizontal"
      aspectRatio="1.35 / 1"
      barGap={0.38}
      margin={{ top: 4, right: 12, bottom: 4, left: 76 }}
    >
      <Bar dataKey="views" fill="var(--chart-line-primary)" lineCap={4} />
      <BarYAxis />
      <ChartTooltip showDatePill={false} rows={(p) => [{ color: 'var(--chart-line-primary)', label: String(p.name), value: Number(p.views) }]} />
    </BarChart>
  );
}

/* ------------------------------------------------------------------ */

const RATING: Record<VitalRating, { label: string; dot: string; text: string }> = {
  good: { label: 'Good', dot: 'bg-good', text: 'text-good' },
  'needs-improvement': { label: 'Needs improvement', dot: 'bg-warn', text: 'text-warn' },
  poor: { label: 'Poor', dot: 'bg-poor', text: 'text-poor' },
};

export function VitalsChart() {
  return (
    <div className="flex flex-col gap-5">
      <div className="relative mx-auto w-full max-w-[300px]">
        <Gauge
          value={REAL_EXPERIENCE_SCORE}
          minWidth={0}
          totalNotches={36}
          activeFill="var(--good)"
        />
        {/* Own label instead of `centerValue` (NumberFlow injects a <style>, blocked by our CSP). */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-2">
          <span className="text-5xl font-semibold tracking-tighter tabular-nums">{REAL_EXPERIENCE_SCORE}</span>
          <span className="text-xs font-medium text-good">Great</span>
        </div>
      </div>
      <p className="-mt-14 text-center text-xs text-muted-foreground">Real Experience Score</p>
      <ul className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-1">
        {VITALS.map((m) => (
          <li key={m.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', RATING[m.rating].dot)} aria-hidden="true" />
              <abbr title={m.name} className="font-medium no-underline">
                {m.key}
              </abbr>
              <span className="sr-only">({RATING[m.rating].label})</span>
            </span>
            <span className={cn('font-mono text-[13px] tabular-nums', m.rating === 'good' ? 'text-foreground' : RATING[m.rating].text)}>
              {m.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function DevicesChart() {
  const [hovered, setHovered] = useState<number | null>(null);
  return (
    <div className="flex items-center gap-5">
      <div className="w-[148px] shrink-0">
        <RingChart
          data={DEVICES}
          strokeWidth={10}
          ringGap={5}
          baseInnerRadius={34}
          hoveredIndex={hovered}
          onHoverChange={setHovered}
        >
          {DEVICES.map((d, i) => (
            <Ring key={d.label} index={i} color={d.color} />
          ))}
        </RingChart>
      </div>
      <Legend
        items={DEVICES.map((d) => ({ label: d.label, value: d.value, maxValue: 100, color: d.color }))}
        hoveredIndex={hovered}
        onHoverChange={setHovered}
        className="min-w-0 flex-1 gap-0.5"
      >
        <LegendItem className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <LegendMarker />
            <LegendLabel className="text-sm" />
          </span>
          <LegendValue formatValue={(v) => `${v}%`} />
        </LegendItem>
      </Legend>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function LiveChart() {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useIsVisible(ref);
  const reduced = useReducedMotion();
  const { data, value } = useLiveVisitors(reduced);
  return (
    <div ref={ref} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight tabular-nums">{intFmt.format(value)}</span>
        <span className="text-sm text-muted-foreground">visitors online</span>
      </div>
      <LiveLineChart
        data={data}
        value={value}
        window={30}
        paused={reduced || !visible}
        margin={{ top: 16, right: 44, bottom: 28, left: 4 }}
        style={{ height: 170, touchAction: 'pan-y' }}
      >
        <Grid horizontal numTicksRows={3} hideHorizontalEdgeLines />
        <LiveLine dataKey="value" formatValue={(v) => String(Math.round(v))} />
        <LiveXAxis numTicks={3} />
      </LiveLineChart>
    </div>
  );
}
