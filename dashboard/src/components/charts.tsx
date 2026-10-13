// Hand-written SVG charts: responsive area/line chart with crosshair + tooltip,
// sparkline and ring gauge. All text is rendered as React text nodes.
import { useId, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Interval } from '../api/types';
import {
  areaPath,
  labelIndices,
  linePath,
  linearScale,
  nearestIndex,
  niceTicks,
  pointX,
  segments,
} from '../lib/chart';
import { axisDateFormat, tooltipDateFormat } from '../lib/format';
import { useElementWidth } from '../hooks/useElementWidth';
import { timeZone } from '../hooks/useStatsQuery';

export interface ChartPoint {
  t: number;
  value: number | null;
  /** optional secondary line in the tooltip, e.g. sample count */
  note?: string;
}

export interface Threshold {
  value: number;
  label: string;
  tone: 'good' | 'poor';
}

const PAD = { top: 12, right: 12, bottom: 28, left: 48 };

export function AreaChart({
  points,
  interval,
  formatValue,
  formatTick = formatValue,
  label,
  height = 260,
  integer = true,
  thresholds = [],
  valueLabel,
}: {
  points: readonly ChartPoint[];
  interval: Interval;
  formatValue: (v: number) => string;
  formatTick?: (v: number) => string;
  label: string;
  height?: number;
  integer?: boolean;
  thresholds?: readonly Threshold[];
  valueLabel: string;
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId().replace(/:/g, '');

  const n = points.length;
  const left = PAD.left;
  const right = Math.max(left + 10, width - PAD.right);
  const top = PAD.top;
  const bottom = height - PAD.bottom;

  const { ticks, yScale } = useMemo(() => {
    const values = points.map((p) => p.value ?? 0);
    const max = Math.max(0, ...values, ...thresholds.map((t) => t.value * 1.1));
    const ticks = niceTicks(max, 4, integer);
    const topTick = ticks[ticks.length - 1] ?? 1;
    return { ticks, yScale: linearScale(0, topTick, bottom, top) };
  }, [points, thresholds, integer, bottom, top]);

  const xOf = (i: number) => pointX(i, n, left, right);
  const segs = useMemo(
    () => segments(points.map((p) => p.value), (i) => pointX(i, n, left, right), yScale),
    [points, n, left, right, yScale],
  );

  const axisFmt = useMemo(() => axisDateFormat(interval, undefined, timeZone), [interval]);
  const tipFmt = useMemo(() => tooltipDateFormat(interval, undefined, timeZone), [interval]);
  const maxLabels = Math.max(2, Math.floor((right - left) / 70));
  const xLabels = labelIndices(n, maxLabels);

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    setHover(nearestIndex(e.clientX - rect.left, n, left, right));
  };

  const hp = hover !== null ? points[hover] : undefined;
  const hx = hover !== null ? xOf(hover) : 0;
  const tipLeft = hover !== null && hx > (left + right) / 2;

  return (
    <div className="chart" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="chart-svg"
      >
        <defs>
          <linearGradient id={`g${gradId}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="chart-grad-top" />
            <stop offset="100%" className="chart-grad-bottom" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={right} y1={yScale(t)} y2={yScale(t)} className="chart-grid" />
            <text x={left - 8} y={yScale(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
              {formatTick(t)}
            </text>
          </g>
        ))}
        {thresholds.map((th) => (
          <g key={th.label}>
            <line
              x1={left}
              x2={right}
              y1={yScale(th.value)}
              y2={yScale(th.value)}
              className={`chart-threshold chart-threshold-${th.tone}`}
            />
          </g>
        ))}
        {segs.map((s, i) => (
          <g key={i}>
            <path d={areaPath(s, bottom)} fill={`url(#g${gradId})`} />
            <path d={linePath(s)} className="chart-line" />
            {s.length === 1 ? <circle cx={s[0]!.x} cy={s[0]!.y} r={3} className="chart-dot" /> : null}
          </g>
        ))}
        {/* Threshold labels on top of the data line, with a halo so they stay readable. */}
        {thresholds.map((th) => (
          <text
            key={th.label}
            x={right - 4}
            y={yScale(th.value) - 5}
            className={`chart-threshold-label chart-threshold-label-${th.tone}`}
            textAnchor="end"
          >
            {th.label}
          </text>
        ))}
        {xLabels.map((i) => {
          const p = points[i];
          if (!p) return null;
          return (
            <text key={i} x={xOf(i)} y={bottom + 18} className="chart-tick" textAnchor={n > 1 && i === 0 ? 'start' : 'middle'}>
              {axisFmt.format(p.t)}
            </text>
          );
        })}
        {hp ? (
          <g>
            <line x1={hx} x2={hx} y1={top} y2={bottom} className="chart-crosshair" />
            {hp.value !== null ? <circle cx={hx} cy={yScale(hp.value)} r={4} className="chart-hover-dot" /> : null}
          </g>
        ) : null}
        <rect
          x={left}
          y={top}
          width={Math.max(0, right - left)}
          height={Math.max(0, bottom - top)}
          className="chart-hit"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hp ? (
        <div
          className={`chart-tooltip${tipLeft ? ' chart-tooltip-left' : ''}`}
          style={{ left: `${hx}px`, top: `${top}px` }}
          role="status"
        >
          <div className="chart-tooltip-title">{tipFmt.format(hp.t)}</div>
          <div className="chart-tooltip-value">
            <span className="chart-tooltip-swatch" />
            <span>{valueLabel}</span>
            <strong>{hp.value === null ? '–' : formatValue(hp.value)}</strong>
          </div>
          {hp.note ? <div className="muted">{hp.note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Sparkline({ values, width = 120, height = 32, label }: { values: readonly number[]; width?: number; height?: number; label: string }) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const y = linearScale(0, max, height - 2, 2);
  const pts = values.map((v, i) => ({ x: pointX(i, n, 1, width - 1), y: y(Number.isFinite(v) ? v : 0) }));
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="sparkline" role="img" aria-label={label}>
      {n > 1 ? (
        <>
          <path d={areaPath(pts, height)} className="sparkline-area" />
          <path d={linePath(pts)} className="sparkline-line" />
        </>
      ) : (
        <line x1={0} x2={width} y1={height - 2} y2={height - 2} className="sparkline-line" />
      )}
    </svg>
  );
}

/** Ring gauge for a 0..100 score. */
export function RingGauge({
  score,
  tone,
  size = 148,
  label,
}: {
  score: number | null;
  tone: 'good' | 'needs-improvement' | 'poor' | 'none';
  size?: number;
  label: string;
}) {
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = score === null ? 0 : Math.max(0, Math.min(100, score));
  const dash = (v / 100) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`gauge gauge-${tone}`} role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} className="gauge-track" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="gauge-value"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="gauge-text">
        {score === null ? '–' : Math.round(score)}
      </text>
    </svg>
  );
}
