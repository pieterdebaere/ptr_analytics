// Public status page (/status/:slug): no login, no app chrome, only
// GET /api/public/status/:slug. Untrusted content is rendered as text / SafeMarkdown,
// the accent colour is validated (#rrggbb) and applied as a CSS variable through the
// React style property (CSSOM, allowed by `style-src 'self'`), the optional tracker
// is our own same-origin /script.js.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { CirclePauseIcon, ExternalLinkIcon, LockKeyholeIcon, RefreshCwIcon, RssIcon, SearchXIcon, ShieldCheckIcon, WrenchIcon } from 'lucide-react';
import { ApiError } from '@/api/client';
import type { DisplayStatus } from '@/api/uptime';
import { statusApi, type PublicBar, type PublicMaintenance, type PublicMonitor, type PublicSection, type PublicStatus, type StatusTheme } from '@/api/status';
import { SafeMarkdown } from '@/components/markdown/SafeMarkdown';
import { IncidentCallout, INCIDENT_STYLE_META, OVERALL_META, incidentMeta } from '@/components/status/incidents';
import { DaysBar } from '@/components/uptime/bars';
import { formatDateTime, formatRelative, formatUptime, uptimeTone } from '@/components/uptime/lib';
import { StatusDot, TagChip } from '@/components/uptime/status';
import { LogoMark } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageVisible } from '@/hooks/usePageVisible';
import { applyStoredTheme } from '@/hooks/useTheme';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;

/* ------------------------------------------------------------------ hooks */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'notfound' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: PublicStatus; fetchedAt: number; refreshError: boolean };

function usePublicStatus(slug: string): { state: LoadState; refresh: () => void; refreshing: boolean } {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const visible = usePageVisible();
  const ctrlRef = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(() => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRefreshing(true);
    statusApi.publicStatus(slug, ctrl.signal).then(
      (data) => {
        if (ctrl.signal.aborted) return;
        setRefreshing(false);
        setState({ kind: 'ready', data, fetchedAt: Date.now(), refreshError: false });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setRefreshing(false);
        const prev = stateRef.current;
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'notfound' });
        else if (prev.kind === 'ready') setState({ ...prev, refreshError: true });
        else setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not load the status page.' });
      },
    );
  }, [slug]);

  // initial load + manual refresh
  useEffect(() => {
    setState({ kind: 'loading' });
  }, [slug]);
  useEffect(() => {
    load();
    return () => ctrlRef.current?.abort();
  }, [load, nonce]);

  // auto refresh every refreshS while the tab is visible; catch up when it becomes visible
  const ready = state.kind === 'ready' ? state : null;
  const refreshMs = (ready?.data.refreshS ?? 60) * 1000;
  const fetchedAt = ready?.fetchedAt ?? 0;
  useEffect(() => {
    if (!visible || !ready) return;
    const due = Math.max(0, fetchedAt + refreshMs - Date.now());
    const t = window.setTimeout(load, due);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fetchedAt, refreshMs, load, ready !== null]);

  return { state, refresh: useCallback(() => setNonce((n) => n + 1), []), refreshing };
}

function systemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** The page's own theme (independent of the dashboard toggle); restored on unmount. */
function useStatusTheme(theme: StatusTheme | null) {
  const [sysDark, setSysDark] = useState(systemDark);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const on = () => setSysDark(mq?.matches ?? false);
    mq.addEventListener?.('change', on);
    return () => mq?.removeEventListener?.('change', on);
  }, []);
  const dark = theme === 'dark' || ((theme === 'auto' || theme === null) && sysDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  useEffect(() => () => applyStoredTheme(), []);
}

/** document.title and <meta name=robots content=noindex> while mounted. */
function useDocumentMeta(title: string, noindex: boolean) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
  useEffect(() => {
    if (!noindex) return;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [noindex]);
}

/** Loads our own tracker (same-origin /script.js only — validated by the API parser). */
function useTracker(analytics: PublicStatus['analytics']) {
  const siteId = analytics?.siteId ?? null;
  const src = analytics?.scriptUrl ?? null;
  useEffect(() => {
    if (!siteId || src !== '/script.js') return;
    const s = document.createElement('script');
    s.src = src;
    s.defer = true;
    s.dataset.site = siteId;
    document.head.appendChild(s);
    return () => s.remove();
  }, [siteId, src]);
}

function useMediaQuery(query: string): boolean {
  const get = () => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

/** Re-render every `ms` (relative timestamps). */
function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
}

/* ------------------------------------------------------------------ helpers */

const MONITOR_LABEL: Record<DisplayStatus, string> = {
  up: 'Operational',
  down: 'Outage',
  pending: 'Degraded',
  maintenance: 'Maintenance',
  unknown: 'No data',
  paused: 'Paused',
};

const MONITOR_TEXT: Record<DisplayStatus, string> = {
  up: 'text-good',
  down: 'text-poor',
  pending: 'text-warn',
  maintenance: 'text-chart-1',
  unknown: 'text-muted-foreground',
  paused: 'text-muted-foreground',
};

/** `days` daily bars ending today; missing days are filled as "no data". */
function padBars(bars: readonly PublicBar[], days: number): PublicBar[] {
  const shown = bars.slice(-days);
  if (shown.length >= days) return shown;
  const first = shown[0]?.t ?? new Date().setHours(0, 0, 0, 0);
  const pad: PublicBar[] = [];
  for (let k = days - shown.length; k >= 1; k--) pad.push({ t: first - k * DAY, upRatio: null, maintenance: false });
  return pad.concat(shown);
}

function sectionSummary(s: PublicSection): { label: string; tone: string } {
  const statuses = s.monitors.map((m) => m.status);
  if (statuses.some((x) => x === 'down')) return { label: `${statuses.filter((x) => x === 'down').length} with outage`, tone: 'text-poor' };
  if (statuses.some((x) => x === 'pending')) return { label: 'Degraded', tone: 'text-warn' };
  if (statuses.some((x) => x === 'maintenance')) return { label: 'Maintenance', tone: 'text-chart-1' };
  if (statuses.length > 0 && statuses.every((x) => x === 'up')) return { label: 'Operational', tone: 'text-good' };
  return { label: '', tone: 'text-muted-foreground' };
}

function maintenanceMeta(m: PublicMaintenance): string {
  const active = m.status === 'under-maintenance';
  const range = m.start && m.end ? `${formatDateTime(m.start)} – ${formatDateTime(m.end)}` : m.end ? `until ${formatDateTime(m.end)}` : m.start ? `from ${formatDateTime(m.start)}` : '';
  return [active ? 'In progress' : 'Scheduled', range].filter(Boolean).join(' · ');
}

/* ------------------------------------------------------------------ page */

export function PublicStatusPage() {
  const { slug = '' } = useParams();
  const { state, refresh, refreshing } = usePublicStatus(slug);
  const data = state.kind === 'ready' ? state.data : null;

  useStatusTheme(data ? data.theme : null);
  useDocumentMeta(
    data ? displayText(data.title) : state.kind === 'notfound' ? 'Status page not found' : 'Status',
    data ? data.noindex : state.kind === 'notfound',
  );
  useTracker(data?.analytics ?? null);

  return (
    <StatusShell accent={data?.accent ?? null} className="min-h-dvh">
      {state.kind === 'loading' ? (
        <LoadingSkeleton />
      ) : state.kind === 'notfound' ? (
        <NotFound />
      ) : state.kind === 'error' ? (
        <ErrorScreen message={state.message} onRetry={refresh} />
      ) : (
        <StatusContent data={state.data} slug={slug} fetchedAt={state.fetchedAt} refreshError={state.refreshError} refreshing={refreshing} onRefresh={refresh} />
      )}
    </StatusShell>
  );
}

/** Page background, accent variable and the accent bar. */
export function StatusShell({ accent, className, children }: { accent: string | null; className?: string; children: ReactNode }) {
  const style = useMemo(() => ({ '--sp-accent': accent ?? 'var(--chart-1)' }) as CSSProperties, [accent]);
  return (
    <div className={cn('flex flex-col bg-muted/40 text-foreground dark:bg-background', className)} style={style} data-slot="public-status">
      <div className="h-1 w-full shrink-0 bg-[color:var(--sp-accent)]" aria-hidden="true" />
      {children}
    </div>
  );
}

const SHELL = 'mx-auto w-full max-w-3xl px-4 sm:px-6';
// Accent links, nudged towards the text colour so any accent stays readable in both themes.
const LINK = 'text-[color:color-mix(in_oklch,var(--sp-accent)_80%,black)] dark:text-[color:color-mix(in_oklch,var(--sp-accent)_65%,white)]';

export function StatusContent({
  data,
  slug,
  fetchedAt,
  refreshError,
  refreshing,
  onRefresh,
}: {
  data: PublicStatus;
  slug: string;
  fetchedAt: number;
  refreshError: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  useTick(15_000);
  const wide = useMediaQuery('(min-width: 640px)');
  const days = wide ? 90 : 60;
  const active = data.incidents.filter((i) => i.resolvedAt === null);
  const past = data.incidents
    .filter((i) => i.resolvedAt !== null)
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const overall = OVERALL_META[data.overall];
  const OverallIcon = overall.icon;
  const monitorCount = data.sections.reduce((n, s) => n + s.monitors.length, 0);

  return (
    <>
      <header className={cn(SHELL, 'flex flex-col gap-5 pt-10 pb-8 sm:pt-14')}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {data.logoUrl ? <img src={data.logoUrl} alt="" className="h-10 w-auto max-w-40 shrink-0 object-contain sm:h-12" /> : null}
            <h1 className="bidi-isolate min-w-0 text-2xl font-semibold tracking-tight break-words sm:text-3xl">{displayText(data.title)}</h1>
          </div>
          <a
            href={`/status/${encodeURIComponent(slug)}/feed.xml`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <RssIcon className="size-4" aria-hidden="true" />
            <span className="max-sm:sr-only">Subscribe</span>
          </a>
        </div>
        {data.description ? <SafeMarkdown source={data.description} className="max-w-2xl text-[0.95rem] text-muted-foreground" linkClassName={LINK} /> : null}
      </header>

      <main className={cn(SHELL, 'flex flex-1 flex-col gap-8 pb-12')}>
        <section aria-label="Overall status" className={cn('flex items-center gap-4 rounded-2xl border px-4 py-4 sm:px-6 sm:py-5', overall.soft)} data-overall={data.overall}>
          <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full text-white shadow-sm', overall.solid)}>
            <OverallIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-lg leading-tight font-semibold sm:text-xl">{monitorCount === 0 && data.overall === 'unknown' ? 'No services listed yet' : overall.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {refreshError ? (
                <span className="text-warn">Couldn&apos;t refresh — showing data from {formatRelative(fetchedAt)}.</span>
              ) : (
                <>Updated {formatRelative(data.updatedAt ?? fetchedAt)}</>
              )}
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Refresh status" disabled={refreshing} className="shrink-0 text-muted-foreground">
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
          </Button>
        </section>

        {data.paused ? (
          <p className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground" role="status">
            <CirclePauseIcon className="size-4 shrink-0" aria-hidden="true" />
            Monitoring is currently paused. The statuses below may be out of date.
          </p>
        ) : null}

        {data.maintenance.length > 0 || active.length > 0 ? (
          <section aria-label="Current notices" className="flex flex-col gap-3">
            {active.map((i) => (
              <IncidentCallout key={i.id} style={i.style} title={i.title} body={i.body} meta={incidentMeta(i)} linkClassName={LINK} className="bg-card" />
            ))}
            {data.maintenance.map((m, k) => (
              <IncidentCallout key={`m${k}`} style="info" icon={WrenchIcon} title={m.title} body={m.description} meta={maintenanceMeta(m)} linkClassName={LINK} className="bg-card" />
            ))}
          </section>
        ) : null}

        {data.sections.map((s, i) => (
          <Section key={i} section={s} days={days} tz={data.tz ?? undefined} />
        ))}

        <section aria-labelledby="past-incidents" className="flex flex-col gap-3">
          <h2 id="past-incidents" className="text-base font-semibold">
            Past incidents
          </h2>
          {past.length === 0 ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No incidents reported recently.</p>
          ) : (
            <ol className="flex flex-col divide-y rounded-xl border bg-card">
              {past.map((i) => {
                const meta = INCIDENT_STYLE_META[i.style];
                return (
                  <li key={i.id} className="flex gap-3 px-4 py-4 sm:px-5">
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', meta.dot)} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <h3 className="bidi-isolate text-sm font-semibold break-words">{displayText(i.title) || 'Untitled'}</h3>
                      {i.body ? <SafeMarkdown source={i.body} className="mt-1 text-sm text-muted-foreground" linkClassName={LINK} /> : null}
                      <p className="mt-1.5 text-xs text-muted-foreground">{incidentMeta(i)}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </main>

      <footer className="border-t bg-background/60">
        <div className={cn(SHELL, 'flex flex-col gap-3 py-6 text-sm text-muted-foreground sm:flex-row sm:items-start sm:justify-between')}>
          {data.footer ? <SafeMarkdown source={data.footer} className="min-w-0 flex-1 text-sm" linkClassName={LINK} /> : <span className="flex-1" />}
          {data.showPoweredBy ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs" data-slot="powered-by">
              Powered by <LogoMark className="size-4" /> <span className="font-medium text-foreground">PTR Analytics</span>
            </span>
          ) : null}
        </div>
      </footer>
    </>
  );
}

function Section({ section, days, tz }: { section: PublicSection; days: number; tz?: string }) {
  const summary = sectionSummary(section);
  return (
    <section aria-label={section.name ? displayText(section.name) : 'Services'} className="overflow-hidden rounded-xl border bg-card shadow-xs">
      {section.name ? (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3 sm:px-5">
          <h2 className="bidi-isolate min-w-0 truncate text-sm font-semibold">{displayText(section.name)}</h2>
          {summary.label ? <span className={cn('shrink-0 text-xs font-medium', summary.tone)}>{summary.label}</span> : null}
        </div>
      ) : null}
      {section.monitors.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">No services in this group.</p>
      ) : (
        <ul className="divide-y">
          {section.monitors.map((m) => (
            <MonitorRow key={m.id} monitor={m} days={days} tz={tz} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MonitorRow({ monitor: m, days, tz }: { monitor: PublicMonitor; days: number; tz?: string }) {
  const status = m.status;
  const bars = padBars(m.bars, days);
  const name = displayText(m.name) || 'Unnamed service';
  return (
    <li className="px-4 py-4 sm:px-5" data-monitor={m.id}>
      <div className="flex items-start gap-3">
        <StatusDot status={status} className="mt-1.5" pulse={status === 'down'} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {m.url ? (
              <a
                href={m.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="bidi-isolate inline-flex min-w-0 items-center gap-1 font-medium break-words outline-none hover:underline hover:underline-offset-4 focus-visible:underline"
              >
                {name}
                <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </a>
            ) : (
              <span className="bidi-isolate font-medium break-words">{name}</span>
            )}
            {m.tags.map((t, i) => (
              <TagChip key={i} name={t.name} value={t.value ?? undefined} color={t.color} />
            ))}
          </div>
          {m.certDaysLeft !== null ? (
            <p className={cn('mt-0.5 inline-flex items-center gap-1 text-xs', m.certDaysLeft < 7 ? 'text-poor' : m.certDaysLeft < 21 ? 'text-warn' : 'text-muted-foreground')}>
              {m.certDaysLeft < 0 ? <LockKeyholeIcon className="size-3" aria-hidden="true" /> : <ShieldCheckIcon className="size-3" aria-hidden="true" />}
              {m.certDaysLeft < 0 ? 'Certificate expired' : `Certificate valid for ${m.certDaysLeft} ${m.certDaysLeft === 1 ? 'day' : 'days'}`}
            </p>
          ) : null}
        </div>
        <span className={cn('shrink-0 text-sm font-medium', MONITOR_TEXT[status])}>{MONITOR_LABEL[status]}</span>
      </div>
      <DaysBar bars={bars} tz={tz} className="mt-3" />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
        <span>{days} days ago</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span className={cn('font-medium', uptimeTone(m.uptime90d))}>{formatUptime(m.uptime90d)} uptime</span>
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span>Today</span>
      </div>
    </li>
  );
}

function LoadingSkeleton() {
  return (
    <div className={cn(SHELL, 'flex flex-col gap-6 pt-14')} aria-busy="true" aria-label="Loading status">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-20 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchXIcon className="size-6" aria-hidden="true" />
      </span>
      <h1 className="text-xl font-semibold">Status page not found</h1>
      <p className="max-w-sm text-sm text-muted-foreground">This status page doesn&apos;t exist or hasn&apos;t been published yet. Check the address and try again.</p>
    </main>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center" role="alert">
      <h1 className="text-xl font-semibold">Status temporarily unavailable</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        <RefreshCwIcon aria-hidden="true" />
        Try again
      </Button>
    </main>
  );
}
