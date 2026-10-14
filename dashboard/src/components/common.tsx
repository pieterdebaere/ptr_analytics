// Small shared building blocks on top of the shadcn/ui components.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircleIcon, ArrowDownRightIcon, ArrowLeftIcon, ArrowUpRightIcon, CheckIcon, CopyIcon, InfoIcon, Loader2Icon, RotateCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { changeTone, formatChange } from '@/lib/format';
import { cn } from '@/lib/utils';

/* ---------------- Page header ---------------- */

/**
 * The one back-navigation pattern of the app: "← Parent" link above the page title
 * (e.g. `<BackLink to="/uptime">Uptime</BackLink>`). `label` is the full text for long names.
 */
export function BackLink({ to, children, label, className }: { to: string; children: ReactNode; label?: string; className?: string }) {
  return (
    <Link
      to={to}
      title={label}
      data-slot="back-link"
      className={cn(
        '-ml-1 inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 self-start rounded-md px-1 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <ArrowLeftIcon className="size-4 shrink-0" aria-hidden="true" />
      <span className="bidi-isolate truncate">{children}</span>
    </Link>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <div className="mt-1 text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ---------------- States ---------------- */

export function ErrorState({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg px-4 py-8 text-center text-sm text-destructive',
        className,
      )}
    >
      <AlertCircleIcon className="size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      {icon ? (
        <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <strong className="text-sm font-medium">{title}</strong>
      {children ? <div className="max-w-prose text-sm text-muted-foreground [&_p+p]:mt-2">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-flex text-muted-foreground', className)}>
      <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
    </span>
  );
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  const widths = ['w-11/12', 'w-3/4', 'w-2/3', 'w-1/2', 'w-5/12'];
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-8', widths[i % widths.length])} />
      ))}
    </div>
  );
}

/* ---------------- Change badge ---------------- */

export function ChangeBadge({
  change,
  lowerIsBetter = false,
  className,
}: {
  change: number | null;
  lowerIsBetter?: boolean;
  className?: string;
}) {
  const text = formatChange(change);
  if (!text) return null;
  const tone = changeTone(change, lowerIsBetter);
  const up = (change ?? 0) > 0;
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-xs font-medium tabular-nums',
        tone === 'good' && 'bg-good/12 text-good-text',
        tone === 'bad' && 'bg-poor/12 text-poor-text',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {tone !== 'neutral' ? (
        up ? (
          <ArrowUpRightIcon className="size-3" aria-hidden="true" />
        ) : (
          <ArrowDownRightIcon className="size-3" aria-hidden="true" />
        )
      ) : null}
      {text}
    </span>
  );
}

/* ---------------- Copy / code ---------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'fixed -left-[9999px] top-0 opacity-0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
    >
      {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}</span>
    </Button>
  );
}

export function CodeBlock({ code, copy = true }: { code: string; copy?: boolean }) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 text-[0.8rem] leading-relaxed">
        <code>{code}</code>
      </pre>
      {copy ? <CopyButton text={code} className="shrink-0 bg-background" /> : null}
    </div>
  );
}

/* ---------------- Info tooltip ---------------- */

export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="More information"
            className={cn(
              'inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
              className,
            )}
          />
        }
      >
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-pretty">{text}</TooltipContent>
    </Tooltip>
  );
}

/* ---------------- Status dot ---------------- */

export function LiveDot({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2', className)} aria-hidden="true">
      {active ? <span className="live-ping absolute inline-flex size-full rounded-full bg-live" /> : null}
      <span className={cn('relative inline-flex size-2 rounded-full', active ? 'bg-live' : 'bg-muted-foreground/40')} />
    </span>
  );
}
