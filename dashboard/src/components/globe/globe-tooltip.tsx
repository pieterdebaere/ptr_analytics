import { motion, useReducedMotion, useSpring } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { countryName } from '@/lib/countries';
import type { HoverInfo } from './engine';

export interface GlobeTooltipProps {
  hover: HoverInfo;
  valueLabel: string;
  formatValue: (value: number) => string;
  containerWidth: number;
  containerHeight: number;
}

const OFFSET = 14;
const SPRING = { stiffness: 380, damping: 32, mass: 0.6 };

const percentFmt = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

function place(x: number, y: number, w: number, h: number, cw: number, ch: number) {
  const flip = x + OFFSET + w > cw;
  const left = flip ? Math.max(4, x - OFFSET - w) : x + OFFSET;
  const top = Math.max(4, Math.min(y - h / 2, ch - h - 4));
  return { left, top, flip };
}

/** Floating tooltip in the visual language of the Bklit chart tooltip. */
export function GlobeTooltip({ hover, valueLabel, formatValue, containerWidth, containerHeight }: GlobeTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 160, h: 64 });
  const reduce = useReducedMotion();
  const initial = place(hover.x, hover.y, size.current.w, size.current.h, containerWidth, containerHeight);
  const left = useSpring(initial.left, SPRING);
  const top = useSpring(initial.top, SPRING);
  const [flip, setFlip] = useState(initial.flip);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.offsetWidth > 0) size.current = { w: el.offsetWidth, h: el.offsetHeight };
    const p = place(hover.x, hover.y, size.current.w, size.current.h, containerWidth, containerHeight);
    if (reduce) {
      left.jump(p.left);
      top.jump(p.top);
    } else {
      left.set(p.left);
      top.set(p.top);
    }
    setFlip(p.flip);
  }, [hover.x, hover.y, containerWidth, containerHeight, left, top, reduce]);

  const name = countryName(hover.code);
  return (
    <motion.div
      ref={ref}
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute z-20 min-w-[148px] overflow-hidden rounded-lg shadow-lg backdrop-blur-md"
      style={{
        left,
        top,
        transformOrigin: flip ? 'right center' : 'left center',
        backgroundColor: 'var(--chart-tooltip-background, oklch(0.21 0.006 285 / 0.8))',
        color: 'var(--chart-tooltip-foreground, oklch(0.985 0 0))',
      }}
      initial={reduce ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
    >
      <div className="px-3 py-2.5">
        <div className="mb-2 text-left font-medium text-xs">{name}</div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: hover.color }} />
              <span className="text-sm" style={{ color: 'var(--chart-tooltip-muted, oklch(0.65 0.01 260))' }}>
                {valueLabel}
              </span>
            </div>
            <span className="font-medium text-sm tabular-nums">{formatValue(hover.value)}</span>
          </div>
          {hover.share > 0 && (
            <div className="flex items-center justify-between gap-4">
              <span className="pl-[18px] text-xs" style={{ color: 'var(--chart-tooltip-muted, oklch(0.65 0.01 260))' }}>
                share
              </span>
              <span className="text-xs tabular-nums" style={{ color: 'var(--chart-tooltip-muted, oklch(0.65 0.01 260))' }}>
                {percentFmt.format(hover.share)}
              </span>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
