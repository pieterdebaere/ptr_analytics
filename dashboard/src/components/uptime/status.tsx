import type { ReactNode } from 'react';
import type { DisplayStatus } from '@/api/uptime';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, STATUS_STYLES } from './lib';

/** Coloured status dot; pulses for down monitors. */
export function StatusDot({ status, className, pulse = true }: { status: DisplayStatus; className?: string; pulse?: boolean }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} aria-hidden="true" data-status={status}>
      {pulse && (status === 'down' || status === 'pending') ? (
        <span className={cn('live-ping absolute inline-flex size-full rounded-full opacity-60', s.bg)} />
      ) : null}
      <span className={cn('relative inline-flex size-full rounded-full ring-4', s.bg, s.ring)} />
    </span>
  );
}

/** Pill with dot + label ("Up", "Down" …). */
export function StatusPill({ status, children, className, size = 'default' }: { status: DisplayStatus; children?: ReactNode; className?: string; size?: 'default' | 'lg' }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium whitespace-nowrap',
        size === 'lg' ? 'h-7 px-3 text-sm' : 'h-5 px-2 text-xs',
        s.soft,
        className,
      )}
      data-status={status}
    >
      <span className={cn('size-1.5 rounded-full', s.bg)} aria-hidden="true" />
      {children ?? STATUS_LABELS[status]}
    </span>
  );
}

/** Small tag chip with the tag's colour as a dot (colour validated as #rrggbb by the API client). */
export function TagChip({ name, value, color, className }: { name: string; value?: string; color: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-5 max-w-40 min-w-0 items-center gap-1 rounded-md border bg-background px-1.5 text-[11px] font-medium text-muted-foreground', className)}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="bidi-isolate truncate">
        {displayText(name)}
        {value ? <span className="font-normal">: {displayText(value)}</span> : null}
      </span>
    </span>
  );
}
