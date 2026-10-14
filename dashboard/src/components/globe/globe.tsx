import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { countryName } from '@/lib/countries';
import { cn } from '@/lib/utils';
import { normalizeAlpha2 } from './country-codes';
import { GlobeEngine, type HoverInfo } from './engine';
import { countryCentroid } from './geo';
import { GlobeControls } from './globe-controls';
import { GlobeTooltip } from './globe-tooltip';

/** Aggregated value per country (ISO 3166-1 alpha-2, upper case). */
export interface GlobeCountryValue {
  country: string;
  value: number;
}

/** A transient "live" ping (e.g. a new pageview) drawn as a pulse at the country. */
export interface GlobePing {
  /** unique id; a ping is animated once when it first appears */
  id: string;
  country: string;
}

export interface GlobeProps {
  /** Countries to shade (choropleth intensity) and to place markers on. */
  countries?: readonly GlobeCountryValue[];
  /** Live pings; pass the most recent ones, old ids are ignored after animating. */
  pings?: readonly GlobePing[];
  /** Slowly rotate when the user is not interacting (default true). */
  autoRotate?: boolean;
  /** Show the zoom in / zoom out / reset buttons (default true). */
  controls?: boolean;
  /** Label used in the tooltip, e.g. "visitors" (default "visitors"). */
  valueLabel?: string;
  /** Optional overlay rendered on top of the canvas (e.g. a live counter). */
  children?: ReactNode;
  className?: string;
  /**
   * Accent colour for markers, tint, glow and pings: any CSS colour or
   * `var(--token)`. Default: `var(--chart-1)` (falls back to `--foreground`
   * when it has too little contrast with the background).
   */
  accentColor?: string;
  /** Initial view centre as [longitude, latitude] (default [10, 25], Europe/Africa). */
  initialCenter?: readonly [number, number];
  /** Zoom with the mouse wheel / trackpad pinch (default true). */
  scrollZoom?: boolean;
  /** Formats values in the tooltip and the accessible summary. */
  formatValue?: (value: number) => string;
}

const DEFAULT_CENTER: readonly [number, number] = [10, 25];
const numberFmt = new Intl.NumberFormat();
const defaultFormat = (v: number) => numberFmt.format(v);

function summarize(countries: readonly GlobeCountryValue[] | undefined, valueLabel: string, format: (v: number) => string): string {
  const totals = new Map<string, number>();
  for (const c of countries ?? []) {
    const code = normalizeAlpha2(c?.country);
    const v = Number(c?.value);
    // same rules as the engine: unknown codes are not drawn, so not announced
    if (!code || !Number.isFinite(v) || v <= 0 || !countryCentroid(code)) continue;
    totals.set(code, (totals.get(code) ?? 0) + v);
  }
  if (totals.size === 0) return `Interactive globe, no ${valueLabel} to show`;
  const top = [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, v]) => `${countryName(code)} ${format(v)}`)
    .join(', ');
  const n = totals.size;
  return `Globe showing ${valueLabel} from ${n} ${n === 1 ? 'country' : 'countries'}. Top: ${top}`;
}

export function Globe({
  countries,
  pings,
  autoRotate = true,
  controls = true,
  valueLabel = 'visitors',
  children,
  className,
  accentColor,
  initialCenter = DEFAULT_CENTER,
  scrollZoom = true,
  formatValue = defaultFormat,
}: GlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GlobeEngine | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [zoom, setZoom] = useState(1);
  const reduce = useReducedMotion();
  const hintId = useId();

  // Latest props for the one-time engine construction.
  const initRef = useRef({ autoRotate, scrollZoom, accentColor, initialCenter });
  initRef.current = { autoRotate, scrollZoom, accentColor, initialCenter };

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const init = initRef.current;
    const engine = new GlobeEngine(container, canvas, {
      autoRotate: init.autoRotate,
      scrollZoom: init.scrollZoom,
      accentColor: init.accentColor,
      initialCenter: [init.initialCenter[0], init.initialCenter[1]],
      onHover: setHover,
      onZoom: setZoom,
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setCountries(countries);
  }, [countries]);

  useEffect(() => {
    engineRef.current?.setPings(pings);
  }, [pings]);

  const [centerLon, centerLat] = initialCenter;
  useEffect(() => {
    engineRef.current?.setOptions({ autoRotate, scrollZoom, accentColor, initialCenter: [centerLon, centerLat] });
  }, [autoRotate, scrollZoom, accentColor, centerLon, centerLat]);

  const zoomIn = useCallback(() => engineRef.current?.zoomBy(1.6), []);
  const zoomOut = useCallback(() => engineRef.current?.zoomBy(1 / 1.6), []);
  const reset = useCallback(() => engineRef.current?.resetView(), []);

  const label = useMemo(() => summarize(countries, valueLabel, formatValue), [countries, valueLabel, formatValue]);
  const el = containerRef.current;

  return (
    <div
      ref={containerRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-operable globe (arrows rotate, +/- zoom)
      tabIndex={0}
      role="group"
      aria-roledescription="interactive globe"
      aria-label={label}
      aria-describedby={hintId}
      data-slot="globe"
      className={cn(
        'relative isolate aspect-square w-full select-none overflow-hidden rounded-xl outline-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <span id={hintId} className="sr-only">
        Drag or use the arrow keys to rotate. Scroll, pinch or press plus and minus to zoom, zero to reset.
      </span>
      <motion.div
        className="absolute inset-0"
        initial={reduce ? false : { opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 block h-full w-full"
          style={{ cursor: 'grab', touchAction: 'pan-y' }}
        />
      </motion.div>
      {children !== undefined && children !== null && <div className="pointer-events-none absolute inset-0 z-10">{children}</div>}
      {controls && <GlobeControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />}
      <AnimatePresence>
        {hover && (
          <GlobeTooltip
            key="globe-tooltip"
            hover={hover}
            valueLabel={valueLabel}
            formatValue={formatValue}
            containerWidth={el?.clientWidth ?? 0}
            containerHeight={el?.clientHeight ?? 0}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
