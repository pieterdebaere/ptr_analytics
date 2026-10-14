import { useId } from 'react';
import { cn } from '@/lib/utils';

/** The PTR Analytics mark: a rising "pulse" line in a rounded tile. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-7', className)}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="oklch(0.72 0.15 225)" />
          <stop offset="1" stopColor="oklch(0.5 0.21 264)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id}-bg)`} />
      <path
        d="M7 21.5l4.5-5 4 3.5 5.5-8 4 4"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="25" cy="16" r="1.9" fill="#fff" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold tracking-tight', className)}>
      <LogoMark />
      <span>
        PTR <span className="text-muted-foreground">Analytics</span>
      </span>
    </span>
  );
}
