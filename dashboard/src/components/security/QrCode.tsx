import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { encodeQr } from './qr';

/**
 * QR code drawn as one SVG path (no data: URL, no canvas). Always dark-on-white with a
 * quiet zone of 4 modules, also in dark mode — scanners need that contrast.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return null;
  const quiet = 4;
  const dim = qr.size + quiet * 2;
  let d = '';
  for (let y = 0; y < qr.size; y++) {
    const row = qr.modules[y]!;
    for (let x = 0; x < qr.size; x++) {
      if (!row[x]) continue;
      // merge horizontal runs into one rectangle
      let run = 1;
      while (x + run < qr.size && row[x + run]) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dim} ${dim}`}
      shapeRendering="crispEdges"
      className={cn('block rounded-lg bg-white', className)}
      data-qr-version={qr.version}
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
