import type { ReactNode } from 'react';
import type { DisplayStatus } from '@/api/uptime';
import { cn } from '@/lib/utils';
import type { LiveMode } from './live';
import { STATUS_LABELS, STATUS_STYLES } from './lib';

/** "Live" / "Updating every 30 s" / "Paused" indicator for the stream state. */
export function LiveBadge({ mode, className }: { mode: LiveMode; className?: string }) {
  const label = mode === 'live' ? 'Live' : mode === 'polling' ? 'Auto-refresh 30 s' : mode === 'paused' ? 'Paused' : 'Connecting…';
  return (
    <span className={cn('inline-flex h-8 items-center gap-2 rounded-lg border bg-background px-2.5 text-xs font-medium text-muted-foreground dark:bg-input/30', className)} title={mode === 'live' ? 'Receiving live updates' : undefined}>
      <span className="relative inline-flex size-2" aria-hidden="true">
        {mode === 'live' ? <span className="live-ping absolute inline-flex size-full rounded-full bg-live" /> : null}
        <span className={cn('relative inline-flex size-2 rounded-full', mode === 'live' ? 'bg-live' : mode === 'polling' ? 'bg-warn' : 'bg-muted-foreground/40')} />
      </span>
      {label}
    </span>
  );
}

/** Small KPI card (label, big value, optional sub line). */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-xl bg-card p-4 ring-1 ring-foreground/10', className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('truncate text-2xl font-semibold tracking-tight tabular-nums', tone)}>{value}</div>
      {sub ? (
        <div className="min-h-4 truncate text-xs text-muted-foreground" title={typeof sub === 'string' ? sub : undefined}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/** Status count cards that double as a status filter. */
export function StatusCountCards({
  counts,
  active,
  onSelect,
}: {
  counts: Record<DisplayStatus, number>;
  active: DisplayStatus | '';
  onSelect: (s: DisplayStatus | '') => void;
}) {
  const order: DisplayStatus[] = ['up', 'down', 'pending', 'maintenance', 'paused'];
  const short: Partial<Record<DisplayStatus, string>> = { maintenance: 'Maint.' };
  return (
    // < sm: one compact row of five; sm: 3 + 2; lg: one row
    <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5" role="group" aria-label="Filter by status">
      {order.map((s) => {
        const n = counts[s] + (s === 'pending' ? counts.unknown : 0);
        const selected = active === s;
        const st = STATUS_STYLES[s];
        return (
          <button
            key={s}
            type="button"
            aria-pressed={selected}
            aria-label={`${STATUS_LABELS[s]}: ${n}`}
            onClick={() => onSelect(selected ? '' : s)}
            className={cn(
              'flex min-w-0 flex-col-reverse gap-0.5 rounded-xl bg-card px-2 py-2.5 text-left ring-1 ring-foreground/10 outline-none transition-shadow hover:ring-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50 sm:flex-col sm:gap-1.5 sm:p-4',
              s === 'down' && n > 0 && 'bg-poor/5 ring-poor/30 hover:ring-poor/50',
              selected && 'ring-2 ring-foreground/60 hover:ring-foreground/60',
            )}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground sm:text-xs" aria-hidden="true">
              <span className={cn('hidden size-2 shrink-0 rounded-full sm:inline-block', st.bg)} />
              <span className="truncate sm:hidden">{short[s] ?? STATUS_LABELS[s]}</span>
              <span className="hidden truncate sm:inline">{STATUS_LABELS[s]}</span>
            </span>
            <span className={cn('flex items-center gap-1.5 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl', n > 0 && s === 'down' ? st.text : 'text-foreground')} aria-hidden="true">
              <span className={cn('size-2 shrink-0 rounded-full sm:hidden', st.bg)} />
              {n}
            </span>
          </button>
        );
      })}
    </div>
  );
}
