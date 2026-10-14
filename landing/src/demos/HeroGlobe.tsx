/** The hero's live 3D globe with fake traffic. Lazy-loaded (d3-geo + world atlas). */
import { useMemo } from 'react';
import { Globe, useDemoTraffic } from '@/components/globe';
import { useReducedMotion } from '~/hooks/useReducedMotion';

const intFmt = new Intl.NumberFormat('en-US');

function useCountryName(): (code: string) => string {
  return useMemo(() => {
    try {
      const names = new Intl.DisplayNames(['en'], { type: 'region' });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, []);
}

export default function HeroGlobe() {
  const reduced = useReducedMotion();
  const { countries, pings, total, last } = useDemoTraffic({ enabled: !reduced });
  const countryName = useCountryName();

  return (
    // On touch screens the globe is display-only so it never traps page scrolling
    // (the canvas uses `touch-action: none` for drag-to-rotate).
    <div className="size-full [@media(pointer:coarse)]:pointer-events-none">
      <Globe
        countries={countries}
        pings={pings}
        controls={false}
        scrollZoom={false}
        accentColor="var(--brand)"
        valueLabel="visitors"
        className="size-full"
      >
        <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur-md sm:top-6 sm:left-6">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="live-ping absolute inline-flex size-full rounded-full bg-good" />
            <span className="relative inline-flex size-2 rounded-full bg-good" />
          </span>
          <span className="tabular-nums">{intFmt.format(total)}</span>
          <span className="text-muted-foreground">visitors today</span>
        </div>
        {last ? (
          <div
            className="pointer-events-none absolute right-3 bottom-3 rounded-full border bg-background/70 px-3 py-1.5 text-xs shadow-sm backdrop-blur-md sm:right-6 sm:bottom-6"
            aria-hidden="true"
          >
            <span className="text-muted-foreground">New visitor from </span>
            <span className="font-medium">{countryName(last.country)}</span>
          </div>
        ) : null}
      </Globe>
    </div>
  );
}
