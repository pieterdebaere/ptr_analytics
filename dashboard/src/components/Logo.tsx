import { cn } from '@/lib/utils';

/** PTR Analytics mark (same shape as /favicon.svg); follows the text colour. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cn('size-6 shrink-0', className)}>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path
        d="M7 22l6-7 4 4 8-10"
        fill="none"
        className="stroke-background"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <LogoMark />
      <span className={cn(compact && 'max-sm:sr-only')}>PTR Analytics</span>
    </span>
  );
}
