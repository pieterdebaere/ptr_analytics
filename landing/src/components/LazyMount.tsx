import { type ReactNode, Suspense, useRef } from 'react';
import { useInViewOnce } from '~/hooks/useInView';
import { cn } from '@/lib/utils';

/**
 * Renders `children` only once the placeholder scrolls near the viewport.
 * Keeps heavy chart code (and its animation) out of the initial render.
 */
export function LazyMount({ children, className, fallback }: { children: ReactNode; className?: string; fallback?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInViewOnce(ref, '300px');
  const placeholder = fallback ?? <div className="size-full animate-pulse rounded-lg bg-muted/40" />;
  return (
    <div ref={ref} className={cn('relative', className)}>
      {inView ? <Suspense fallback={placeholder}>{children}</Suspense> : placeholder}
    </div>
  );
}
