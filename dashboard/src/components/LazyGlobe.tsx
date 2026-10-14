// The globe (canvas + land data, ~66 KB gzip) is loaded on demand so the initial bundle stays small.
import { lazy, Suspense } from 'react';
import type { GlobeProps } from '@/components/globe';
import { cn } from '@/lib/utils';

const GlobeImpl = lazy(() => import('@/components/globe').then((m) => ({ default: m.Globe })));

export function LazyGlobe(props: GlobeProps) {
  return (
    <Suspense
      fallback={
        <div className={cn('relative flex items-center justify-center overflow-hidden', props.className)} aria-busy="true">
          <div className="aspect-square h-[70%] animate-pulse rounded-full bg-muted/60" />
          {props.children ? <div className="pointer-events-none absolute inset-0">{props.children}</div> : null}
        </div>
      }
    >
      <GlobeImpl {...props} />
    </Suspense>
  );
}
