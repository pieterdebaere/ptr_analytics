// Heartbeat bar (last N beats) and the 90-day uptime bar. One shared, cheap tooltip
// per bar (no per-segment popovers) so long monitor lists stay fast.
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DayBar, HeartbeatInterval, HeartbeatPoint } from '@/api/uptime';
import { statusName } from '@/api/uptime';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { beatClass, dayClass, formatDateTime, formatDay, formatLatency, formatUptime, STATUS_LABELS, UPTIME_LEGEND_EXTRA, UPTIME_TIERS } from './lib';

interface Segment {
  key: string | number;
  className: string;
  tip: ReactNode;
}

function SegmentBar({
  segments,
  slots,
  label,
  summary,
  className,
  barClassName,
}: {
  segments: readonly Segment[];
  /** total number of slots; missing (older) slots are drawn empty on the left */
  slots: number;
  label: string;
  summary: string;
  className?: string;
  barClassName?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const tipId = useId();
  const empty = Math.max(0, slots - segments.length);
  const shown = segments.slice(-slots);
  const total = empty + shown.length;
  const activeSeg = active !== null ? shown[active] : undefined;
  // tooltip anchor in % of the bar width (centre of the active slot)
  const left = active !== null ? ((empty + active + 0.5) / Math.max(1, total)) * 100 : 0;
  const align = left < 18 ? 'start' : left > 82 ? 'end' : 'center';

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive((a) => {
        if (e.key === 'Home') return 0;
        if (e.key === 'End') return shown.length - 1;
        const cur = a ?? shown.length - 1;
        return Math.min(shown.length - 1, Math.max(0, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
      });
    } else if (e.key === 'Escape') setActive(null);
  };

  return (
    <div
      className={cn('relative min-w-0', className)}
      role="group"
      aria-label={label}
      aria-describedby={activeSeg ? tipId : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
    >
      <span className="sr-only">{summary}</span>
      <div className={cn('flex h-6 items-stretch gap-[2px] outline-none', barClassName)} aria-hidden="true">
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="min-w-0 flex-1 rounded-[2px] bg-muted-foreground/12" />
        ))}
        {shown.map((s, i) => (
          <span
            key={s.key}
            className={cn(
              'min-w-0 flex-1 rounded-[2px] transition-[transform,opacity] duration-150',
              s.className,
              active !== null && active !== i && 'opacity-55',
              active === i && 'scale-y-110',
            )}
            onPointerEnter={() => setActive(i)}
          />
        ))}
      </div>
      {activeSeg ? (
        <div
          id={tipId}
          role="tooltip"
          className={cn(
            'pointer-events-none absolute bottom-full z-30 mb-2 w-max max-w-64 rounded-lg bg-chart-tooltip-background px-2.5 py-1.5 text-xs text-chart-tooltip-foreground shadow-lg backdrop-blur-sm',
            align === 'center' && '-translate-x-1/2',
            align === 'end' && '-translate-x-full',
          )}
          style={{ left: `${align === 'start' ? 0 : left}%`, ...(align === 'end' ? { left: '100%' } : {}) }}
        >
          {activeSeg.tip}
        </div>
      ) : null}
    </div>
  );
}

export interface BeatLike {
  t: number;
  status: HeartbeatPoint['status'];
  latencyMs?: number | null;
  msg?: string | null;
  upRatio?: number | null;
}

/** Last `slots` heartbeats, colour coded (oldest left, newest right). */
export function HeartbeatBar({
  beats,
  slots = 50,
  interval = 'raw',
  label = 'Recent checks',
  className,
  barClassName,
}: {
  beats: readonly BeatLike[];
  slots?: number;
  interval?: HeartbeatInterval;
  label?: string;
  className?: string;
  barClassName?: string;
}) {
  const shown = beats.slice(-slots);
  const down = shown.filter((b) => b.status === 0).length;
  const segments: Segment[] = shown.map((b) => ({
    key: b.t,
    className: beatClass(b.status),
    tip: (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 font-medium">
          <span className={cn('size-1.5 rounded-full', beatClass(b.status))} />
          {STATUS_LABELS[statusName(b.status)]}
          <span className="font-normal text-chart-tooltip-muted tabular-nums">· {formatDateTime(b.t, interval === 'raw')}</span>
        </div>
        {interval !== 'raw' && typeof b.upRatio === 'number' ? <div className="tabular-nums">Uptime {formatUptime(b.upRatio)}</div> : null}
        {typeof b.latencyMs === 'number' ? <div className="tabular-nums">{formatLatency(b.latencyMs)}</div> : null}
        {b.msg ? <div className="bidi-isolate line-clamp-3 break-words text-chart-tooltip-muted">{displayText(b.msg)}</div> : null}
      </div>
    ),
  }));
  const summary = shown.length === 0 ? 'No checks yet.' : `${shown.length} checks shown, ${down} down. Use the arrow keys to inspect them.`;
  return <SegmentBar segments={segments} slots={slots} label={label} summary={summary} className={className} barClassName={barClassName} />;
}

/** One bar per local day (90 days), coloured by uptime. */
export function DaysBar({ bars, tz, className }: { bars: readonly DayBar[]; tz?: string; className?: string }) {
  const known = bars.filter((b) => b.upRatio !== null);
  const bad = known.filter((b) => (b.upRatio ?? 1) < 0.999).length;
  const segments: Segment[] = bars.map((b) => ({
    key: b.t,
    className: dayClass(b.upRatio, b.maintenance),
    tip: (
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">{formatDay(b.t, tz)}</div>
        <div className="tabular-nums">{b.upRatio === null ? 'No data' : `Uptime ${formatUptime(b.upRatio)}`}</div>
        {b.maintenance ? <div className="text-chart-tooltip-muted">Maintenance window</div> : null}
      </div>
    ),
  }));
  return (
    <SegmentBar
      segments={segments}
      slots={Math.max(bars.length, 1)}
      label="Daily uptime"
      summary={`${bars.length} days, ${known.length} with data, ${bad} below 99.9%. Use the arrow keys to inspect them.`}
      className={className}
      barClassName="h-9 gap-[2px] sm:gap-[3px]"
    />
  );
}

/** Colour legend for the 90-day bar (same tiers as uptime percentages, see UPTIME_TIERS). */
export function UptimeLegend({ className, maintenance = true }: { className?: string; maintenance?: boolean }) {
  const items = [
    ...UPTIME_TIERS.map((t) => ({ label: t.label, bar: t.bar })),
    ...UPTIME_LEGEND_EXTRA.filter((e) => maintenance || e.label !== 'Maintenance'),
  ];
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground', className)} aria-label="Uptime colour legend">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className={cn('size-2.5 rounded-[2px]', it.bar)} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}
