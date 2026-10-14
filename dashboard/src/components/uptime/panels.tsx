// Cards of the monitor detail page.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightIcon,
  BadgeCheckIcon,
  BellIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { errorMessage } from '@/api/client';
import { uptimeApi, statusName, type Monitor, type MonitorEvent, type Outage } from '@/api/uptime';
import { CodeBlock, CopyButton, EmptyState, ErrorState, SkeletonRows } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './actions';
import { daysUntil, expiryTone, formatDateLong, formatDateTime, formatDurationMs, STATUS_LABELS } from './lib';
import { isSafePushUrl, maskPushUrl, pushExample, PUSH_EXAMPLE_LANGS, type PushExampleLang } from './push';
import { StatusPill } from './status';
import { toast } from './toast';
import { everyText } from './monitor-form';

function KV({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('bidi-isolate min-w-0 text-sm break-words', mono && 'font-mono text-xs')}>{children}</dd>
    </div>
  );
}

/* ---------------- events ---------------- */

const EVENTS_PAGE = 20;

export function EventsCard({ uid, refreshKey }: { uid: string; refreshKey: number }) {
  const first = useApi((signal) => uptimeApi.events(uid, { limit: EVENTS_PAGE }, signal), [uid, refreshKey]);
  const [more, setMore] = useState<MonitorEvent[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMore([]);
    setDone(false);
  }, [uid, refreshKey]);
  const events = [...(first.data ?? []), ...more];
  const canMore = !done && (first.data?.length ?? 0) >= EVENTS_PAGE;
  const loadMore = async () => {
    const last = events[events.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      const page = await uptimeApi.events(uid, { before: last.id, limit: EVENTS_PAGE });
      setMore((m) => [...m, ...page]);
      if (page.length < EVENTS_PAGE) setDone(true);
    } catch (err) {
      toast(errorMessage(err) || 'Could not load events.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">Events</CardTitle>
        <CardDescription>Status changes</CardDescription>
      </CardHeader>
      <CardContent>
        {first.error ? (
          <ErrorState message={first.error} onRetry={first.reload} />
        ) : first.loading && !first.data ? (
          <SkeletonRows rows={4} />
        ) : events.length === 0 ? (
          <EmptyState title="No status changes yet" className="py-6" />
        ) : (
          <>
            <ol className="relative flex flex-col" aria-label="Status changes">
              {events.map((e, i) => (
                <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {i < events.length - 1 ? <span className="absolute top-5 bottom-0 left-[5px] w-px bg-border" aria-hidden="true" /> : null}
                  <span className={cn('relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-card ring-1 ring-border', statusBg(e.to))} aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <StatusPill status={statusName(e.to)} />
                      {e.from !== null ? <span className="text-xs text-muted-foreground">from {STATUS_LABELS[statusName(e.from)].toLowerCase()}</span> : null}
                      <time className="ml-auto text-xs text-muted-foreground tabular-nums" dateTime={new Date(e.ts).toISOString()} title={new Date(e.ts).toLocaleString()}>
                        {formatDateTime(e.ts)}
                      </time>
                    </div>
                    {e.msg ? <p className="bidi-isolate text-xs break-words text-muted-foreground">{displayText(e.msg)}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
            {canMore ? (
              <Button type="button" variant="outline" size="sm" className="mt-4 w-full" onClick={() => void loadMore()} disabled={busy}>
                {busy ? 'Loading…' : 'Load older events'}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function statusBg(s: number): string {
  return { down: 'bg-poor', up: 'bg-good', pending: 'bg-warn', maintenance: 'bg-maint', unknown: 'bg-muted-foreground/40' }[statusName(s)];
}

/* ---------------- outages ---------------- */

export function OutagesCard({ uid, refreshKey }: { uid: string; refreshKey: number }) {
  const { data, error, loading, reload } = useApi((signal) => uptimeApi.outages(uid, 25, signal), [uid, refreshKey]);
  const now = Date.now();
  return (
    <Card className="gap-3 pb-0">
      <CardHeader>
        <CardTitle className="text-sm">Outages</CardTitle>
        <CardDescription>Confirmed downtime, newest first</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !data ? (
          <SkeletonRows rows={3} className="px-4 pb-4" />
        ) : !data || data.length === 0 ? (
          <EmptyState title="No outages recorded" className="py-6 pb-10" icon={<BadgeCheckIcon />} />
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[42%] pl-4">Started</TableHead>
                <TableHead className="w-24 text-right">Duration</TableHead>
                <TableHead className="pr-4">Cause</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((o: Outage) => (
                <TableRow key={o.id}>
                  <TableCell className="pl-4 text-xs tabular-nums">
                    <time dateTime={new Date(o.startedAt).toISOString()}>{formatDateTime(o.startedAt)}</time>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {o.endedAt === null ? <span className="font-medium text-poor-text">Ongoing · {formatDurationMs(now - o.startedAt)}</span> : formatDurationMs(o.endedAt - o.startedAt)}
                  </TableCell>
                  <TableCell className="pr-4 text-xs text-muted-foreground">
                    <span className="bidi-isolate block truncate" title={o.cause ? displayText(o.cause) : undefined}>
                      {o.cause ? displayText(o.cause) : '–'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- certificate ---------------- */

export function CertificateCard({ monitor }: { monitor: Monitor }) {
  const tls = monitor.tls;
  const [chainOpen, setChainOpen] = useState(false);
  const days = tls?.daysLeft ?? daysUntil(tls?.notAfter);
  const ok = tls ? tls.valid && (days === null || days >= 0) : false;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {ok ? <ShieldCheckIcon className="size-4 text-good-text" aria-hidden="true" /> : <ShieldAlertIcon className={cn('size-4', tls ? 'text-poor-text' : 'text-muted-foreground')} aria-hidden="true" />}
          TLS certificate
        </CardTitle>
        {tls ? (
          <CardAction>
            <Badge variant="outline" className={cn(ok ? 'border-good/40 text-good-text' : 'border-poor/40 text-poor-text')}>
              {ok ? 'Valid' : 'Invalid'}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {!tls ? (
          <p className="text-sm text-muted-foreground">No certificate seen yet. It is captured on the next successful TLS check.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline gap-2">
              <span className={cn('text-3xl font-semibold tracking-tight tabular-nums', expiryTone(days))}>{days ?? '–'}</span>
              <span className="text-sm text-muted-foreground">days left · valid until {formatDateLong(tls.notAfter)}</span>
            </div>
            {tls.error ? <p className="bidi-isolate rounded-md bg-poor/8 px-2.5 py-1.5 text-xs text-poor-text">{displayText(tls.error)}</p> : null}
            <dl className="flex flex-col gap-2">
              {tls.subject ? <KV label="Subject">{displayText(tls.subject)}</KV> : null}
              <KV label="Issuer">{tls.issuer ? displayText(tls.issuer) : '–'}</KV>
              {tls.notBefore ? <KV label="Valid from">{formatDateLong(tls.notBefore)}</KV> : null}
              {tls.sans && tls.sans.length > 0 ? (
                <KV label="Names">
                  {displayText(tls.sans.slice(0, 6).join(', '))}
                  {tls.sans.length > 6 ? ` +${tls.sans.length - 6} more` : ''}
                </KV>
              ) : null}
              {tls.hostnameOk === false ? <KV label="Host name">Does not match the certificate</KV> : null}
              {tls.fingerprint256 ? (
                <KV label="SHA-256" mono>
                  <span className="break-all">{displayText(tls.fingerprint256)}</span>
                </KV>
              ) : null}
            </dl>
            {tls.chain && tls.chain.length > 0 ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="-mx-1 flex h-7 items-center gap-1 self-start rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  aria-expanded={chainOpen}
                  onClick={() => setChainOpen((o) => !o)}
                >
                  <ChevronRightIcon className={cn('size-3.5 transition-transform', chainOpen && 'rotate-90')} aria-hidden="true" />
                  Certificate chain ({tls.chain.length})
                </button>
                {chainOpen ? (
                  <ol className="flex flex-col gap-2 border-l pl-3">
                    {tls.chain.map((c, i) => (
                      <li key={`${c.fingerprint256 ?? ''}-${i}`} className="flex flex-col gap-0.5 text-xs">
                        <span className="bidi-isolate font-medium break-words">{c.subject ? displayText(c.subject) : 'Unknown subject'}</span>
                        <span className="bidi-isolate text-muted-foreground">
                          Issued by {c.issuer ? displayText(c.issuer) : '–'} · until {formatDateLong(c.notAfter)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {monitor.certNotify ? 'You are notified 21, 14, 7, 3 and 1 days before it expires.' : 'Expiry notifications are off for this monitor.'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- domain ---------------- */

export function DomainCard({ monitor }: { monitor: Monitor }) {
  const d = monitor.domain;
  const days = d?.daysLeft ?? daysUntil(d?.expiresAt);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CalendarClockIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Domain registration
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!d || d.expiresAt === null ? (
          <p className="text-sm text-muted-foreground">
            {monitor.domainNotify ? 'Not looked up yet (RDAP). It appears after the next check.' : 'Domain expiry tracking is off for this monitor.'}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline gap-2">
              <span className={cn('text-3xl font-semibold tracking-tight tabular-nums', expiryTone(days))}>{days ?? '–'}</span>
              <span className="text-sm text-muted-foreground">days left · expires {formatDateLong(d.expiresAt)}</span>
            </div>
            {d.domain ? (
              <dl>
                <KV label="Domain">{displayText(d.domain)}</KV>
              </dl>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- push ---------------- */

export function PushPanel({ monitor, pushUrl, onPushUrl, canManage }: { monitor: Monitor; pushUrl: string | null; onPushUrl: (url: string) => void; canManage: boolean }) {
  const [reveal, setReveal] = useState(false);
  const [lang, setLang] = useState<PushExampleLang>('curl');
  const [confirm, setConfirm] = useState(false);
  const url = isSafePushUrl(pushUrl) ? pushUrl : null;
  const shown = url ? (reveal ? url : maskPushUrl(url)) : null;
  const example = pushExample(lang, url ?? '<PUSH_URL>', monitor.intervalS);
  const exampleShown = url && !reveal ? pushExample(lang, maskPushUrl(url), monitor.intervalS) : example;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Push URL
        </CardTitle>
        <CardDescription>
          Call this URL from your job at least {everyText(monitor.intervalS)}. Without a push in that time the monitor goes down.
          Optional parameters: <code>status=up|down</code>, <code>msg</code>, <code>ping</code> (ms). The token can also be sent in an{' '}
          <code>X-Push-Token</code> header to <code>/api/push</code> (keeps it out of access logs; at most 1 push per second).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {url ? (
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs" aria-label="Push URL">
                {shown}
              </code>
              <Button type="button" variant="outline" size="icon" aria-label={reveal ? 'Hide push URL' : 'Show push URL'} aria-pressed={reveal} onClick={() => setReveal((r) => !r)}>
                {reveal ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
              </Button>
              <CopyButton text={url} className="h-8 bg-background" />
            </div>
            <p className="text-xs text-warn-text">Copy it now: for your security it is shown only once and cannot be displayed again later.</p>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
            The push URL contains a secret token and is shown only once, right after it is created. Regenerate it to get a new one — the old URL
            stops working immediately.
          </p>
        )}
        {canManage ? (
          <div>
            <Button type="button" variant="outline" onClick={() => setConfirm(true)}>
              <RefreshCwIcon aria-hidden="true" />
              {url ? 'Regenerate URL' : 'Generate new URL'}
            </Button>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-2">
          <Tabs value={lang} onValueChange={(v) => setLang(v as PushExampleLang)}>
            <TabsList variant="line" aria-label="Example" className="scrollbar-none h-8 w-full justify-start overflow-x-auto max-sm:h-10">
              {PUSH_EXAMPLE_LANGS.map((l) => (
                <TabsTrigger key={l.key} value={l.key} className="flex-none px-2 text-[13px]">
                  {l.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {url && !reveal ? (
            <div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
              <pre className="min-w-0 flex-1 overflow-x-auto py-1 text-[0.8rem] leading-relaxed">
                <code>{exampleShown}</code>
              </pre>
              <CopyButton text={example} className="shrink-0 bg-background" />
            </div>
          ) : (
            <CodeBlock code={example} />
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Regenerate push URL?"
        description="A new secret URL is created and the current one stops working immediately. Update every job that calls it."
        confirmLabel="Regenerate"
        destructive
        onConfirm={async () => {
          const next = await uptimeApi.regeneratePushToken(monitor.uid);
          if (!next) throw new Error('No push URL returned.');
          onPushUrl(next);
          setReveal(true);
          toast('New push URL created — copy it now.');
        }}
      />
    </Card>
  );
}

/* ---------------- badges ---------------- */

const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function badgeUrls(origin: string, publicId: string): Array<{ key: string; label: string; path: string; url: string }> {
  const base = `/api/public/badge/${encodeURIComponent(publicId)}`;
  const list = [
    { key: 'status', label: 'Status', path: `${base}/status.svg` },
    { key: 'uptime', label: 'Uptime (30 days)', path: `${base}/uptime.svg?period=30d` },
    { key: 'response', label: 'Response time', path: `${base}/response.svg` },
    { key: 'cert', label: 'Certificate expiry', path: `${base}/cert.svg` },
  ];
  return list.map((b) => ({ ...b, url: `${origin.replace(/\/+$/, '')}${b.path}` }));
}

export function BadgesPanel({ monitor, onChanged, canManage }: { monitor: Monitor; onChanged: (publicId: string | null) => void; canManage: boolean }) {
  const { config } = useAuth();
  const [busy, setBusy] = useState(false);
  const publicId = monitor.publicId && PUBLIC_ID_RE.test(monitor.publicId) ? monitor.publicId : null;
  const origin = config?.publicUrl && /^https?:\/\//.test(config.publicUrl) ? config.publicUrl : window.location.origin;
  const badges = publicId ? badgeUrls(origin, publicId).filter((b) => b.key !== 'cert' || monitor.tls) : [];
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const id = await uptimeApi.setBadges(monitor.uid, enabled);
      onChanged(enabled ? id : null);
    } catch (err) {
      toast(errorMessage(err) || 'Could not change badges.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">Badges</CardTitle>
        <CardDescription>Public SVG badges for READMEs and docs. They reveal only this monitor’s status and figures.</CardDescription>
        {canManage ? (
          <CardAction>
            <Switch checked={publicId !== null} onCheckedChange={(c) => void toggle(c)} disabled={busy} aria-label="Enable public badges" />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {!publicId ? (
          <p className="text-sm text-muted-foreground">Badges are off. {canManage ? 'Turn them on to get a public, unguessable badge URL.' : ''}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {badges.map((b) => (
              <li key={b.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
                <span className="w-32 shrink-0 text-xs text-muted-foreground">{b.label}</span>
                <img src={b.path} alt={`${b.label} badge`} className="h-5 max-w-40" loading="lazy" decoding="async" />
                <span className="ml-auto flex gap-1.5">
                  <CopyButton text={`![${b.label}](${b.url})`} label="Markdown" />
                  <CopyButton text={b.url} label="URL" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------- notification channels ---------------- */

export function ChannelsCard({ monitor, canManage }: { monitor: Monitor; canManage: boolean }) {
  const { data, error } = useApi((signal) => uptimeApi.listChannels(signal), []);
  const byUid = new Map((data ?? []).map((c) => [c.uid, c]));
  const linked = monitor.channelUids.map((uid) => byUid.get(uid) ?? { uid, name: 'Unknown channel', type: '', active: true, isDefault: false });
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <BellIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Notifications
        </CardTitle>
        <CardAction>
          <Link to="/notifications" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-muted-foreground')}>
            Channels
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {linked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No notification channels — nobody is alerted when this monitor goes down.{' '}
            {canManage ? (
              <Link to={`/monitors/${encodeURIComponent(monitor.uid)}/edit#notifications`} className="font-medium text-foreground underline underline-offset-4">
                Add one
              </Link>
            ) : null}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {linked.map((c) => (
              <li key={c.uid} className="flex min-w-0 items-center gap-2 text-sm">
                <span className={cn('size-1.5 shrink-0 rounded-full', c.active ? 'bg-good' : 'bg-muted-foreground/40')} aria-hidden="true" />
                <span className="bidi-isolate truncate">{displayText(c.name)}</span>
                {c.type ? <span className="shrink-0 text-xs text-muted-foreground">{displayText(c.type)}</span> : null}
                {!c.active ? <Badge variant="secondary" className="ml-auto">Paused</Badge> : null}
              </li>
            ))}
          </ul>
        )}
        {error && !data ? <p className="mt-2 text-xs text-muted-foreground">Channel names unavailable.</p> : null}
      </CardContent>
    </Card>
  );
}


