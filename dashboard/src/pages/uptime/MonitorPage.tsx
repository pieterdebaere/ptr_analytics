import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ActivityIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  TimerIcon,
  Trash2Icon,
  TrendingDownIcon,
  ZapIcon,
} from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { uptimeApi, type Monitor } from '@/api/uptime';
import { BackLink, EmptyState, ErrorState } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { DeleteMonitorDialog, useMonitorActions } from '@/components/uptime/actions';
import { DaysBar, HeartbeatBar, UptimeLegend, type BeatLike } from '@/components/uptime/bars';
import { appendBeat, applyBeat, applyState, useInterval, useUptimeStream } from '@/components/uptime/live';
import {
  displayStatus,
  formatDurationMs,
  formatLatency,
  formatRelative,
  formatUptime,
  safeTargetHref,
  STATUS_LABELS,
  typeLabel,
  uptimeTone,
} from '@/components/uptime/lib';
import { everyText } from '@/components/uptime/monitor-form';
import { BadgesPanel, CertificateCard, ChannelsCard, DomainCard, EventsCard, OutagesCard, PushPanel } from '@/components/uptime/panels';
import { PeriodPicker, periodLabel, useUptimePeriod } from '@/components/uptime/PeriodPicker';
import { takePushUrl } from '@/components/uptime/push';
import { ResponseTimeChart } from '@/components/uptime/ResponseTimeChart';
import { StatusPill, TagChip } from '@/components/uptime/status';
import { toast, Toaster } from '@/components/uptime/toast';
import { StatCard } from '@/components/uptime/widgets';
import { useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { usePageVisible } from '@/hooks/usePageVisible';
import { timeZone } from '@/hooks/useStatsQuery';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Types whose checks connect to a TLS endpoint (certificate card shown). */
const TLS_TYPES = new Set(['http', 'keyword', 'json', 'tls', 'websocket', 'grpc_health']);

export function MonitorPage() {
  const { uid = '' } = useParams();
  const valid = UID_RE.test(uid);
  const res = useApi((signal) => uptimeApi.getMonitor(uid, signal), [uid], valid);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  useEffect(() => {
    if (res.data) setMonitor(res.data);
  }, [res.data]);
  useEffect(() => setMonitor(null), [uid]);

  if (!valid || (res.error && !monitor)) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10">
        {valid && res.error !== 'Not found.' ? (
          <ErrorState message={res.error ?? ''} onRetry={res.reload} />
        ) : (
          <EmptyState title="Monitor not found" icon={<ActivityIcon />}>
            <p>
              It may have been deleted.{' '}
              <Link to="/uptime" className="font-medium text-foreground underline underline-offset-4">
                Back to all monitors
              </Link>
            </p>
          </EmptyState>
        )}
      </div>
    );
  }
  if (!monitor) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-72" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[100px] rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }
  return <MonitorDetail key={monitor.uid} monitor={monitor} setMonitor={setMonitor} reload={res.reload} />;
}

function MonitorDetail({ monitor: m, setMonitor, reload }: { monitor: Monitor; setMonitor: (m: Monitor) => void; reload: () => void }) {
  const canManage = useCanManageSites();
  const navigate = useNavigate();
  const visible = usePageVisible();
  const [q, setQ] = useUptimePeriod();
  const qKey = `${q.period}|${q.from ?? ''}|${q.to ?? ''}`;
  const [refreshKey, setRefreshKey] = useState(0);
  const [pushUrl, setPushUrl] = useState<string | null>(() => takePushUrl(m.uid) ?? m.pushUrl);
  const [beats, setBeats] = useState<BeatLike[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = displayStatus(m);

  const site = useApi((signal) => api.getSite(m.siteId, signal), [m.siteId]);
  const types = useApi((signal) => uptimeApi.types(signal), []);
  const typeInfo = types.data?.types.find((t) => t.type === m.type);
  const stats = useApi((signal) => uptimeApi.stats(m.uid, q, signal), [m.uid, qKey, refreshKey]);
  const series = useApi((signal) => uptimeApi.heartbeats(m.uid, q, signal), [m.uid, qKey, refreshKey]);
  const recent = useApi((signal) => uptimeApi.heartbeats(m.uid, { period: '24h', tz: timeZone }, signal), [m.uid]);
  useEffect(() => {
    if (recent.data) setBeats(recent.data.points.slice(-60).map((p) => ({ t: p.t, status: p.status, latencyMs: p.latencyMs, msg: p.msg, upRatio: recent.data!.interval === 'raw' ? undefined : p.upRatio })));
  }, [recent.data]);

  // live updates for this monitor; status changes refresh stats/events (debounced)
  const mRef = useRef(m);
  mRef.current = m;
  const refreshTimer = useRef<number | undefined>(undefined);
  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => setRefreshKey((k) => k + 1), 1500);
  };
  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);
  const mode = useUptimeStream({
    onBeat: (b) => {
      if (b.uid !== mRef.current.uid) return;
      if (b.status !== mRef.current.state.status) scheduleRefresh();
      setMonitor(applyBeat(mRef.current, b));
      setBeats((list) => appendBeat(list, { t: b.ts, status: b.status, latencyMs: b.latencyMs, msg: b.msg }, 60));
    },
    onState: (s) => {
      if (s.uid !== mRef.current.uid) return;
      if (s.status !== mRef.current.state.status) scheduleRefresh();
      setMonitor(applyState(mRef.current, s));
    },
  });
  // polling fallback: refetch the monitor (and the figures less often)
  useInterval(reload, 30_000, visible && mode === 'polling');
  useInterval(() => setRefreshKey((k) => k + 1), 120_000, visible && mode !== 'paused');
  useEffect(() => {
    // extend the bar from polled state
    const ts = m.state.lastCheckAt;
    if (ts !== null) setBeats((list) => (list.length && ts > list[list.length - 1]!.t ? appendBeat(list, { t: ts, status: m.state.status, latencyMs: m.state.latencyMs, msg: m.state.msg }, 60) : list));
  }, [m.state.lastCheckAt, m.state.status, m.state.latencyMs, m.state.msg]);

  useEffect(() => {
    document.title = `${STATUS_LABELS[status]} · ${displayText(m.name)} – PTR Analytics`;
    return () => {
      document.title = 'PTR Analytics';
    };
  }, [status, m.name]);

  const a = useMonitorActions(m, {
    onChanged: setMonitor,
    onRemoved: () => navigate(`/sites/${encodeURIComponent(m.siteId)}/uptime`),
    onReload: reload,
  });

  const targetHref = safeTargetHref(m.target);
  const target = m.target ? displayText(m.target) : null;
  const s = stats.data;
  const upDelta = s && s.uptime !== null && s.previousUptime !== null ? (s.uptime - s.previousUptime) * 100 : null;
  const now = Date.now();
  const showTls = TLS_TYPES.has(m.type) && (m.tls !== null || /^https:|^wss:/i.test(m.target ?? '') || m.type === 'tls');
  const showDomain = m.domainNotify || m.domain !== null || m.type === 'domain';
  const isPush = m.type === 'push';
  const isManual = m.type === 'manual';
  const isGroup = m.type === 'group';
  /** group/manual monitors never measure latency; push monitors only when the job sends `ping` */
  const showLatency = !isGroup && !isManual && !(isPush && s !== undefined && s !== null && s.avgLatencyMs === null);
  const editHref = `/monitors/${encodeURIComponent(m.uid)}/edit`;

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-col gap-2.5">
          <BackLink to={`/sites/${encodeURIComponent(m.siteId)}/uptime`} label={site.data ? `${displayText(site.data.name)} uptime` : undefined} className="-mb-1">
            {site.data ? `${displayText(site.data.name)} uptime` : 'Uptime'}
          </BackLink>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="bidi-isolate min-w-0 truncate text-2xl font-semibold tracking-tight" title={displayText(m.name)}>
              {displayText(m.name)}
            </h1>
            <StatusPill status={status} size="lg" />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Badge variant="secondary">{typeInfo?.label ?? typeLabel(m.type)}</Badge>
            {target ? (
              targetHref ? (
                <a href={targetHref} target="_blank" rel="noopener noreferrer nofollow" className="bidi-isolate inline-flex min-w-0 items-center gap-1 truncate text-foreground hover:underline" title={target}>
                  <span className="truncate">{target}</span>
                  <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </a>
              ) : (
                <span className="bidi-isolate min-w-0 truncate font-mono text-xs text-foreground" title={target}>
                  {target}
                </span>
              )
            ) : null}
            {m.tags.map((t) => (
              <TagChip key={`${t.uid}:${t.value}`} name={t.name} value={t.value} color={t.color} />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {status === 'paused' ? (
              'Paused — no checks are running.'
            ) : (
              <>
                {STATUS_LABELS[status]}
                {m.state.since ? ` for ${formatDurationMs(now - m.state.since)}` : ''}
                {isManual ? (
                  ' · status set manually'
                ) : isGroup ? (
                  ' · status from its child monitors'
                ) : (
                  <>
                    {m.state.lastCheckAt ? ` · ${isPush ? 'last push' : 'checked'} ${formatRelative(m.state.lastCheckAt, now)}` : ''}
                    {` · ${isPush ? 'expected ' : ''}${everyText(m.intervalS)}`}
                  </>
                )}
              </>
            )}
            {m.state.msg && status !== 'paused' ? (
              <>
                {' · '}
                <span className="bidi-isolate break-words">{displayText(m.state.msg)}</span>
              </>
            ) : null}
          </p>
          {m.description ? <p className="bidi-isolate max-w-prose text-sm whitespace-pre-line text-muted-foreground">{displayText(m.description)}</p> : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="bg-background" onClick={a.togglePause} disabled={a.busy !== null}>
              {m.active ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
              {m.active ? 'Pause' : 'Resume'}
            </Button>
            {!isPush && !isGroup && !isManual ? (
              <Button type="button" variant="outline" className="bg-background" onClick={a.checkNow} disabled={a.busy !== null || !m.active}>
                <RefreshCwIcon className={cn(a.busy === 'check' && 'animate-spin')} aria-hidden="true" />
                Check now
              </Button>
            ) : null}
            <Link to={editHref} className={buttonVariants()}>
              <PencilIcon aria-hidden="true" />
              Edit
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="bg-background" aria-label="More actions" />}>
                <MoreHorizontalIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={a.clone}>
                  <CopyIcon aria-hidden="true" />
                  Clone
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2Icon aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DeleteMonitorDialog monitor={m} open={confirmDelete} onOpenChange={setConfirmDelete} onDelete={a.remove} />
          </div>
        ) : null}
      </div>

      {isManual && canManage ? <ManualStatusCard monitor={m} onChanged={setMonitor} /> : null}

      {/* recent beats */}
      <Card size="sm" className="gap-2 px-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{isManual || isGroup ? 'Recent status' : isPush ? 'Recent pushes' : 'Recent checks'}</span>
          <span className="tabular-nums">{m.active && m.state.latencyMs !== null && !isManual && !isGroup ? `Last response ${formatLatency(m.state.latencyMs)}` : ''}</span>
        </div>
        <HeartbeatBar beats={beats} slots={60} interval={recent.data?.interval ?? 'raw'} label={`${isManual || isGroup ? 'Recent status' : 'Recent checks'} of ${displayText(m.name)}`} barClassName="h-8" />
      </Card>

      {/* period + stats */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight">{periodLabel(q)}</h2>
          <PeriodPicker value={q} onChange={setQ} />
        </div>
        {stats.error ? (
          <Card>
            <ErrorState message={stats.error} onRetry={stats.reload} />
          </Card>
        ) : (
          <div className={cn('grid grid-cols-2 gap-3', showLatency ? 'lg:grid-cols-4' : 'lg:grid-cols-3', stats.loading && s && 'opacity-60 transition-opacity')}>
            {!s ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[100px] rounded-xl" />)
            ) : (
              <>
                <StatCard
                  label="Uptime"
                  icon={<ActivityIcon />}
                  value={formatUptime(s.uptime, 3)}
                  tone={uptimeTone(s.uptime)}
                  sub={
                    upDelta === null ? (
                      `${s.checks.toLocaleString()} checks`
                    ) : (
                      <span className={cn(Math.abs(upDelta) < 0.005 ? '' : upDelta > 0 ? 'text-good-text' : 'text-poor-text')} title="Change in percentage points vs the previous period of the same length">
                        {Math.abs(upDelta) < 0.005 ? 'Same as previous period' : `${upDelta > 0 ? '+' : '−'}${Math.abs(upDelta).toFixed(2)} pp vs previous`}
                      </span>
                    )
                  }
                />
                {showLatency ? (
                  <StatCard
                    label="Avg. response"
                    icon={<ZapIcon />}
                    value={formatLatency(s.avgLatencyMs)}
                    sub={s.minLatencyMs !== null && s.maxLatencyMs !== null ? `${formatLatency(s.minLatencyMs)} min · ${formatLatency(s.maxLatencyMs)} max` : 'No data'}
                  />
                ) : null}
                <StatCard
                  label="Outages"
                  icon={<TrendingDownIcon />}
                  value={s.outages.toLocaleString()}
                  tone={s.outages > 0 ? 'text-poor-text' : undefined}
                  sub={s.downtimeMs > 0 ? `${formatDurationMs(s.downtimeMs)} confirmed downtime` : 'No confirmed downtime'}
                />
                <StatCard
                  label="MTTR"
                  icon={<TimerIcon />}
                  value={s.mttrMs !== null ? formatDurationMs(s.mttrMs) : '–'}
                  sub="Mean time to recovery"
                  className={showLatency ? undefined : 'col-span-2 lg:col-span-1'}
                />
              </>
            )}
          </div>
        )}

        {showLatency ? (
          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="text-sm">Response time</CardTitle>
              <CardDescription>
                {series.data?.interval === 'raw' ? 'Every check' : series.data?.interval === 'hour' ? 'Hourly average with min–max range' : 'Daily average with min–max range'}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-2 sm:px-4">
              {series.error ? (
                <ErrorState message={series.error} onRetry={series.reload} className="min-h-56" />
              ) : (
                <ResponseTimeChart key={qKey} points={series.data?.points ?? []} interval={series.data?.interval ?? 'raw'} loading={series.loading || !series.data} />
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-sm">Last 90 days</CardTitle>
          <CardDescription>Daily uptime{s && s.bars.length > 0 ? ` · ${formatUptime(dayAverage(s.bars))} average` : ''}</CardDescription>
        </CardHeader>
        <CardContent>
          {s ? (
            s.bars.length > 0 ? (
              <>
                <DaysBar bars={s.bars} tz={timeZone} />
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span>90 days ago</span>
                  <span>Today</span>
                </div>
                <UptimeLegend className="mt-3" />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            )
          ) : (
            <Skeleton className="h-9 w-full" />
          )}
        </CardContent>
      </Card>

      {isPush ? <PushPanel monitor={m} pushUrl={pushUrl} onPushUrl={setPushUrl} canManage={canManage} /> : null}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <EventsCard uid={m.uid} refreshKey={refreshKey} />
        <OutagesCard uid={m.uid} refreshKey={refreshKey} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {showTls ? <CertificateCard monitor={m} /> : null}
        {showDomain ? <DomainCard monitor={m} /> : null}
        <ChannelsCard monitor={m} canManage={canManage} />
        <BadgesPanel monitor={m} canManage={canManage} onChanged={(publicId) => setMonitor({ ...m, publicId })} />
      </div>
      <Toaster />
    </div>
  );
}

function ManualStatusCard({ monitor, onChanged }: { monitor: Monitor; onChanged: (m: Monitor) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const current = monitor.manualStatus;
  const set = async (status: 'up' | 'down' | 'pending') => {
    setBusy(status);
    try {
      const m = await uptimeApi.setManualStatus(monitor.uid, status);
      if (m) onChanged(m);
      toast(`Status set to ${STATUS_LABELS[status].toLowerCase()}`);
    } catch (err) {
      toast(errorMessage(err) || 'Could not set the status.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const options: Array<{ value: 'up' | 'down' | 'pending'; code: number }> = [
    { value: 'up', code: 1 },
    { value: 'down', code: 0 },
    { value: 'pending', code: 2 },
  ];
  return (
    <Card size="sm" className="flex-row flex-wrap items-center justify-between gap-3 px-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">Manual status</span>
        <span className="text-xs text-muted-foreground">This monitor does not run checks; set its status yourself.</span>
      </div>
      <div className="flex gap-2" role="group" aria-label="Set status">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            variant={current === o.code ? 'default' : 'outline'}
            aria-pressed={current === o.code}
            disabled={busy !== null}
            onClick={() => void set(o.value)}
          >
            <span className={cn('size-2 rounded-full', o.value === 'up' ? 'bg-good' : o.value === 'down' ? 'bg-poor' : 'bg-warn')} aria-hidden="true" />
            {STATUS_LABELS[o.value]}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function dayAverage(bars: ReadonlyArray<{ upRatio: number | null }>): number | null {
  const v = bars.map((b) => b.upRatio).filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
