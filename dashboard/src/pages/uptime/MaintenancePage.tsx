import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClockIcon, GlobeIcon, MoreHorizontalIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { uptimeApi, type Maintenance, type MaintenanceStrategy, type Monitor } from '@/api/uptime';
import { BackLink, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/uptime/actions';
import { CheckRow, FormField, RadioCards, Time24Input } from '@/components/uptime/form-parts';
import { formatRelative } from '@/components/uptime/lib';
import {
  describeSchedule,
  draftFromMaintenance,
  draftToInput,
  emptyDraft,
  mapMaintenanceError,
  nextWindows,
  timeZones,
  validateMaintenance,
  WEEKDAY_SHORT,
  type DraftErrors,
  type MaintenanceDraft,
  type Window,
} from '@/components/uptime/maintenance-schedule';
import { StatusDot } from '@/components/uptime/status';
import { toast, Toaster } from '@/components/uptime/toast';
import { useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { timeZone } from '@/hooks/useStatsQuery';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

const STATUS_META: Record<Maintenance['status'], { label: string; className: string }> = {
  'under-maintenance': { label: 'Under maintenance', className: 'bg-maint/12 text-maint-text' },
  scheduled: { label: 'Scheduled', className: 'bg-muted text-foreground' },
  inactive: { label: 'Paused', className: 'bg-muted text-muted-foreground' },
  ended: { label: 'Ended', className: 'bg-muted text-muted-foreground' },
};
const STATUS_ORDER: Record<Maintenance['status'], number> = { 'under-maintenance': 0, scheduled: 1, inactive: 2, ended: 3 };

const STRATEGIES: Array<{ value: MaintenanceStrategy; label: string; hint: string }> = [
  { value: 'single', label: 'One time', hint: 'A single date range' },
  { value: 'weekly', label: 'Weekly', hint: 'On chosen weekdays' },
  { value: 'monthly', label: 'Monthly', hint: 'On days of the month' },
  { value: 'interval', label: 'Every N days', hint: 'Repeating interval' },
  { value: 'cron', label: 'Cron', hint: 'Cron expression' },
  { value: 'manual', label: 'Manual', hint: 'Switch on and off' },
];

// Maintenance times are always shown in 24-hour format (like the HH:MM inputs and schedule summaries).
const DATE_PARTS: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const TIME_PARTS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtIn(tz: string, withDate = true): Intl.DateTimeFormat {
  const key = `${tz}|${withDate}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(undefined, { timeZone: tz, ...(withDate ? DATE_PARTS : {}), ...TIME_PARTS });
    } catch {
      f = new Intl.DateTimeFormat(undefined, { ...(withDate ? DATE_PARTS : {}), ...TIME_PARTS });
    }
    fmtCache.set(key, f);
  }
  return f;
}

function formatWindow(w: Window, tz: string): string {
  const sameDay = w.end - w.start < 86_400_000 && fmtIn(tz).format(w.start).split(',')[0] === fmtIn(tz).format(w.end).split(',')[0];
  return `${fmtIn(tz).format(w.start)} – ${sameDay ? fmtIn(tz, false).format(w.end) : fmtIn(tz).format(w.end)}`;
}

export function MaintenancePage() {
  const canManage = useCanManageSites();
  const list = useApi((signal) => uptimeApi.listMaintenances(signal), []);
  const monitors = useApi((signal) => uptimeApi.overview(signal).then((r) => r.monitors), []);
  const sites = useApi((signal) => api.listSites(signal), []);
  const [editing, setEditing] = useState<Maintenance | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Maintenance | null>(null);
  const byUid = useMemo(() => new Map((monitors.data ?? []).map((m) => [m.uid, m])), [monitors.data]);
  const sorted = useMemo(
    () =>
      [...(list.data ?? [])].sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.nextWindow?.start ?? Infinity) - (b.nextWindow?.start ?? Infinity) || a.title.localeCompare(b.title),
      ),
    [list.data],
  );

  useEffect(() => {
    document.title = 'Maintenance – PTR Analytics';
    return () => {
      document.title = 'PTR Analytics';
    };
  }, []);

  const toggle = async (m: Maintenance) => {
    try {
      if (m.active) await uptimeApi.pauseMaintenance(m.uid);
      else await uptimeApi.resumeMaintenance(m.uid);
      toast(m.active ? `Paused ${displayText(m.title)}` : `Resumed ${displayText(m.title)}`);
      list.reload();
    } catch (err) {
      toast(errorMessage(err) || 'Something went wrong.', 'error');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink to="/uptime">Uptime</BackLink>
        <PageHeader
          title="Maintenance"
          description="Planned windows pause alerts and show monitors as under maintenance (excluded from uptime)."
          actions={
            canManage ? (
              <Button type="button" onClick={() => setEditing('new')}>
                <PlusIcon aria-hidden="true" />
                New window
              </Button>
            ) : null
          }
        />
      </div>

      {list.error ? (
        <Card>
          <ErrorState message={list.error} onRetry={list.reload} />
        </Card>
      ) : !list.data ? (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState title="No maintenance windows" icon={<WrenchIcon />}>
            <p>Schedule deploys, backups or provider maintenance so they do not trigger alerts or count as downtime.</p>
            {canManage ? (
              <Button type="button" className="mt-4" onClick={() => setEditing('new')}>
                <PlusIcon aria-hidden="true" />
                Schedule a window
              </Button>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((m) => (
            <MaintenanceRow key={m.uid} m={m} monitors={byUid} canManage={canManage} onEdit={() => setEditing(m)} onDelete={() => setDeleting(m)} onToggle={() => void toggle(m)} />
          ))}
        </ul>
      )}

      {editing ? (
        <MaintenanceDialog
          initial={editing === 'new' ? null : editing}
          monitors={monitors.data ?? []}
          siteNames={new Map((sites.data ?? []).map((s) => [s.id, s.name]))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (o ? undefined : setDeleting(null))}
          title="Delete maintenance window?"
          description={
            <>
              <strong className="bidi-isolate font-medium text-foreground">{displayText(deleting.title)}</strong> will be removed. Affected monitors return to
              normal checks and alerts.
            </>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await uptimeApi.deleteMaintenance(deleting.uid);
            toast(`Deleted ${displayText(deleting.title)}`);
            list.reload();
          }}
        />
      ) : null}
      <Toaster />
    </div>
  );
}

function MaintenanceRow({
  m,
  monitors,
  canManage,
  onEdit,
  onDelete,
  onToggle,
}: {
  m: Maintenance;
  monitors: ReadonlyMap<string, Monitor>;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const meta = STATUS_META[m.status];
  const affected = m.monitorUids.map((u) => monitors.get(u)).filter((x): x is Monitor => x !== undefined);
  const now = Date.now();
  return (
    <li className={cn('flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:flex-row sm:items-start sm:gap-4', m.status === 'under-maintenance' && 'ring-maint/40')}>
      <span className={cn('mt-0.5 hidden size-9 shrink-0 items-center justify-center rounded-lg sm:flex', m.status === 'under-maintenance' ? 'bg-maint/12 text-maint-text' : 'bg-muted text-muted-foreground')} aria-hidden="true">
        <WrenchIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="bidi-isolate min-w-0 truncate font-medium" title={displayText(m.title)}>
            {displayText(m.title)}
          </span>
          <span className={cn('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium', meta.className)}>
            {m.status === 'under-maintenance' ? <span className="size-1.5 rounded-full bg-maint" aria-hidden="true" /> : null}
            {meta.label}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {describeSchedule(m)}
          {m.strategy !== 'manual' ? (
            <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap">
              <span aria-hidden="true">&nbsp;·</span>
              <GlobeIcon className="size-3" aria-hidden="true" />
              <span className="bidi-isolate">{displayText(m.tz)}</span>
              <span className="sr-only">time zone</span>
            </span>
          ) : null}
        </p>
        <WindowLine m={m} now={now} />
        {m.description ? <p className="bidi-isolate line-clamp-2 text-xs whitespace-pre-line text-muted-foreground">{displayText(m.description)}</p> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
          {m.monitorUids.length === 0 ? (
            <span className="text-xs text-muted-foreground">No monitors selected</span>
          ) : (
            <>
              {affected.slice(0, 4).map((mon) => (
                <Link
                  key={mon.uid}
                  to={`/monitors/${encodeURIComponent(mon.uid)}`}
                  className="inline-flex h-6 max-w-48 min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 text-xs hover:bg-muted max-sm:h-8"
                  title={displayText(mon.name)}
                >
                  <StatusDot status={mon.active ? (mon.state.status === 3 ? 'maintenance' : mon.state.status === 0 ? 'down' : 'up') : 'paused'} pulse={false} halo={false} className="size-1.5" />
                  <span className="bidi-isolate truncate">{displayText(mon.name)}</span>
                </Link>
              ))}
              {m.monitorUids.length > 4 ? <Badge variant="secondary">+{m.monitorUids.length - 4}</Badge> : null}
            </>
          )}
        </div>
      </div>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
          <Button type="button" variant="outline" className="bg-background" onClick={onEdit}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="bg-background" aria-label={`More actions for ${displayText(m.title)}`} />}>
              <MoreHorizontalIcon aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onToggle}>
                {m.active ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
                {m.active ? 'Pause' : 'Resume'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2Icon aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </li>
  );
}

/** "Ends …" / "Next …" / "Paused — won't start" / "Ended …" line of a window (times in the window's zone, 24 h). */
function WindowLine({ m, now }: { m: Maintenance; now: number }) {
  const w = m.nextWindow;
  let content: ReactNode = null;
  if (m.status === 'inactive') {
    content = <span className="text-muted-foreground">Paused — won’t start until resumed</span>;
  } else if (m.status === 'ended') {
    content =
      m.endsAt !== null ? (
        <span className="text-muted-foreground">
          Ended {fmtIn(m.tz).format(m.endsAt)} <span>({formatRelative(m.endsAt, now)})</span>
        </span>
      ) : (
        <span className="text-muted-foreground">Ended</span>
      );
  } else if (w && m.status === 'under-maintenance' && w.start <= now) {
    content = (
      <span>
        Ends {fmtIn(m.tz).format(w.end)} <span className="text-muted-foreground">({formatRelative(w.end, now)})</span>
      </span>
    );
  } else if (w) {
    content = (
      <span>
        Next {formatWindow(w, m.tz)} <span className="text-muted-foreground">({formatRelative(w.start, now)})</span>
      </span>
    );
  }
  if (!content) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm tabular-nums">
      <CalendarClockIcon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">{content}</span>
    </p>
  );
}

/* ---------------- editor dialog ---------------- */

function TimeInputs({ draft, set, errors }: { draft: MaintenanceDraft; set: (p: Partial<MaintenanceDraft>) => void; errors: DraftErrors }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label="From (24 h)" error={errors.timeStart}>
        {({ id, describedBy, invalid }) => <Time24Input id={id} value={draft.timeStart} onChange={(v) => set({ timeStart: v })} invalid={invalid} describedBy={describedBy} />}
      </FormField>
      <FormField label="Until (24 h)" error={errors.timeEnd} hint={draft.timeEnd && draft.timeStart && draft.timeEnd <= draft.timeStart ? 'Ends the next day' : undefined}>
        {({ id, describedBy, invalid }) => <Time24Input id={id} value={draft.timeEnd} onChange={(v) => set({ timeEnd: v })} invalid={invalid} describedBy={describedBy} />}
      </FormField>
    </div>
  );
}

function DateRange({ draft, set, errors, requireStart }: { draft: MaintenanceDraft; set: (p: Partial<MaintenanceDraft>) => void; errors: DraftErrors; requireStart?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label={requireStart ? 'First day' : 'Effective from'} required={requireStart} error={errors.startLocal} hint={requireStart ? undefined : 'Optional'}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="date" value={draft.startLocal} onChange={(e) => set({ startLocal: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
        )}
      </FormField>
      <FormField label="Effective until" error={errors.endLocal} hint="Optional, inclusive">
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="date" value={draft.endLocal} min={draft.startLocal || undefined} onChange={(e) => set({ endLocal: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
        )}
      </FormField>
    </div>
  );
}

/** Date + 24-hour time for a "YYYY-MM-DDTHH:mm" draft value. */
function DateTime24({ id, value, onChange, minDate, invalid, describedBy }: { id: string; value: string; onChange: (v: string) => void; minDate?: string; invalid: boolean; describedBy?: string }) {
  const [date = '', time = ''] = value.split('T');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
      <Input id={id} type="date" value={date} min={minDate} onChange={(e) => onChange(`${e.target.value}T${time}`)} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
      <Time24Input value={time} onChange={(t) => onChange(`${date}T${t}`)} invalid={invalid} describedBy={describedBy} aria-label="Time (24 h)" />
    </div>
  );
}

function ToggleChip({ pressed, onClick, children, label, className }: { pressed: boolean; onClick: () => void; children: ReactNode; label?: string; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-sm font-medium tabular-nums outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
        pressed ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted dark:bg-input/30',
        className,
      )}
    >
      {children}
    </button>
  );
}

function MaintenanceDialog({
  initial,
  monitors,
  siteNames,
  onClose,
  onSaved,
}: {
  initial: Maintenance | null;
  monitors: readonly Monitor[];
  siteNames: ReadonlyMap<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<MaintenanceDraft>(() => (initial ? draftFromMaintenance(initial) : emptyDraft(timeZone)));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const zones = useMemo(() => timeZones(), []);
  const zonesId = useId();
  const set = (p: Partial<MaintenanceDraft>) => setDraft((d) => ({ ...d, ...p }));
  const preview = useMemo(() => nextWindows(draft, Date.now(), 3), [draft]);

  const q = search.trim().toLowerCase();
  const shownMonitors = monitors.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.target ?? '').toLowerCase().includes(q));
  const bySite = new Map<string, Monitor[]>();
  for (const m of shownMonitors) {
    const list = bySite.get(m.siteId) ?? [];
    list.push(m);
    bySite.set(m.siteId, list);
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateMaintenance(draft);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    try {
      const body = draftToInput(draft);
      if (initial) await uptimeApi.updateMaintenance(initial.uid, body);
      else await uptimeApi.createMaintenance(body);
      toast(initial ? 'Maintenance window saved' : 'Maintenance window created');
      onSaved();
    } catch (err) {
      const mapped = mapMaintenanceError(err);
      setErrors(mapped.errors);
      setFormError(mapped.form);
    } finally {
      setBusy(false);
    }
  };

  const recurring = draft.strategy === 'weekly' || draft.strategy === 'monthly' || draft.strategy === 'interval';

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-2xl" data-slot="maintenance-dialog">
        <DialogHeader className="pr-8">
          <DialogTitle>{initial ? 'Edit maintenance window' : 'New maintenance window'}</DialogTitle>
          <DialogDescription>While a window is active, checks pause, monitors show “maintenance” and no alerts are sent.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" noValidate>
          <div className="-mx-4 flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-1 pb-1">
            <FormField label="Title" required error={errors.title}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} value={draft.title} maxLength={150} placeholder="Database upgrade" autoFocus onChange={(e) => set({ title: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
              )}
            </FormField>
            <FormField label="Description" error={errors.description} hint="Shown on status pages linked to this window.">
              {({ id, describedBy, invalid }) => (
                <Textarea id={id} rows={2} maxLength={5000} value={draft.description} onChange={(e) => set({ description: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
              )}
            </FormField>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Schedule</legend>
              <RadioCards
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                label="Schedule type"
                value={draft.strategy}
                options={STRATEGIES}
                onChange={(v) =>
                  set({
                    strategy: v,
                    ...(v === 'single' && draft.strategy !== 'single' ? { startLocal: emptyDraft(draft.tz).startLocal, endLocal: emptyDraft(draft.tz).endLocal } : {}),
                    ...(v !== 'single' && draft.strategy === 'single' ? { startLocal: '', endLocal: '' } : {}),
                  })
                }
              />
            </fieldset>

            {draft.strategy === 'manual' ? (
              <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
                The window is active whenever it is switched on below, until you pause it.
              </p>
            ) : null}

            {draft.strategy === 'single' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField label="Starts" required error={errors.startLocal}>
                  {({ id, describedBy, invalid }) => <DateTime24 id={id} value={draft.startLocal} onChange={(v) => set({ startLocal: v })} invalid={invalid} describedBy={describedBy} />}
                </FormField>
                <FormField label="Ends" required error={errors.endLocal}>
                  {({ id, describedBy, invalid }) => (
                    <DateTime24 id={id} value={draft.endLocal} minDate={draft.startLocal.split('T')[0] || undefined} onChange={(v) => set({ endLocal: v })} invalid={invalid} describedBy={describedBy} />
                  )}
                </FormField>
              </div>
            ) : null}

            {draft.strategy === 'weekly' ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Weekdays</span>
                <div className="grid grid-cols-7 gap-1.5 sm:flex sm:flex-wrap" role="group" aria-label="Weekdays">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <ToggleChip key={d} pressed={draft.weekdays.includes(d)} onClick={() => set({ weekdays: draft.weekdays.includes(d) ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d] })} className="min-w-0 px-0 sm:w-12">
                      {WEEKDAY_SHORT[d]}
                    </ToggleChip>
                  ))}
                </div>
                {errors.weekdays ? <p className="text-xs text-destructive" role="alert">{errors.weekdays}</p> : null}
              </div>
            ) : null}

            {draft.strategy === 'monthly' ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Days of the month</span>
                <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-[repeat(16,minmax(0,1fr))]" role="group" aria-label="Days of the month">
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <ToggleChip key={d} pressed={draft.daysOfMonth.includes(d)} onClick={() => set({ daysOfMonth: draft.daysOfMonth.includes(d) ? draft.daysOfMonth.filter((x) => x !== d) : [...draft.daysOfMonth, d] })} className="min-w-0 px-0">
                      {d}
                    </ToggleChip>
                  ))}
                  <ToggleChip pressed={draft.daysOfMonth.includes('L')} onClick={() => set({ daysOfMonth: draft.daysOfMonth.includes('L') ? draft.daysOfMonth.filter((x) => x !== 'L') : [...draft.daysOfMonth, 'L'] })} className="col-span-2 sm:col-span-2" label="Last day of the month">
                    Last
                  </ToggleChip>
                </div>
                <p className="text-xs text-muted-foreground">Days that do not exist in a month (e.g. 31) are skipped; “Last” is always the final day.</p>
                {errors.daysOfMonth ? <p className="text-xs text-destructive" role="alert">{errors.daysOfMonth}</p> : null}
              </div>
            ) : null}

            {draft.strategy === 'interval' ? (
              <FormField label="Repeat every" required error={errors.intervalDays}>
                {({ id, describedBy, invalid }) => (
                  <div className="relative w-40">
                    <Input
                      id={id}
                      type="number"
                      min={1}
                      max={3650}
                      value={draft.intervalDays ?? ''}
                      onChange={(e) => set({ intervalDays: e.target.value === '' ? undefined : Number(e.target.value) })}
                      aria-invalid={invalid || undefined}
                      aria-describedby={describedBy}
                      className="pr-12 tabular-nums"
                    />
                    <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">days</span>
                  </div>
                )}
              </FormField>
            ) : null}

            {draft.strategy === 'cron' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <FormField label="Cron expression" required error={errors.cron} hint="minute hour day-of-month month weekday · e.g. 30 2 * * 0 = Sundays 02:30 · L = last day">
                  {({ id, describedBy, invalid }) => (
                    <Input id={id} value={draft.cron} maxLength={120} spellCheck={false} autoComplete="off" className="font-mono" onChange={(e) => set({ cron: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                  )}
                </FormField>
                <FormField label="Duration" required error={errors.durationMin}>
                  {({ id, describedBy, invalid }) => (
                    <div className="relative">
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        max={10080}
                        value={draft.durationMin ?? ''}
                        onChange={(e) => set({ durationMin: e.target.value === '' ? undefined : Number(e.target.value) })}
                        aria-invalid={invalid || undefined}
                        aria-describedby={describedBy}
                        className="pr-12 tabular-nums"
                      />
                      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">min</span>
                    </div>
                  )}
                </FormField>
              </div>
            ) : null}

            {recurring ? <TimeInputs draft={draft} set={set} errors={errors} /> : null}
            {recurring || draft.strategy === 'cron' ? <DateRange draft={draft} set={set} errors={errors} requireStart={draft.strategy === 'interval'} /> : null}

            {draft.strategy !== 'manual' ? (
              <FormField label="Time zone" required error={errors.tz}>
                {({ id, describedBy, invalid }) => (
                  <>
                    <Input id={id} list={zonesId} value={draft.tz} spellCheck={false} autoComplete="off" onChange={(e) => set({ tz: e.target.value })} aria-invalid={invalid || undefined} aria-describedby={describedBy} />
                    <datalist id={zonesId}>
                      {zones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </>
                )}
              </FormField>
            ) : null}

            {draft.strategy !== 'manual' ? (
              <div className="rounded-lg border bg-muted/30 px-3 py-2.5" aria-live="polite">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">Next windows (24 h, {displayText(draft.tz)})</div>
                {preview.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No upcoming window with these settings.</p>
                ) : (
                  <ol className="flex flex-col gap-1">
                    {preview.map((w) => (
                      <li key={w.start} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm tabular-nums">
                        <span>{formatWindow(w, draft.tz)}</span>
                        <span className="text-xs text-muted-foreground">{formatRelative(w.start)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Affected monitors</span>
                <span className="text-xs text-muted-foreground tabular-nums">{draft.monitorUids.length} selected</span>
              </div>
              <p className="text-xs text-muted-foreground">Monitors in a selected group are included automatically.</p>
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter monitors" aria-label="Filter monitors" className="pl-8" />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border p-1">
                {monitors.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">No monitors yet.</p>
                ) : shownMonitors.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground">No monitors match.</p>
                ) : (
                  [...bySite].map(([siteId, list]) => (
                    <div key={siteId} className="flex flex-col">
                      {bySite.size > 1 || siteNames.size > 1 ? (
                        <div className="bidi-isolate px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{displayText(siteNames.get(siteId) ?? 'Site')}</div>
                      ) : null}
                      {list.map((m) => (
                        <CheckRow
                          key={m.uid}
                          checked={draft.monitorUids.includes(m.uid)}
                          onChange={(on) => set({ monitorUids: on ? [...draft.monitorUids, m.uid] : draft.monitorUids.filter((x) => x !== m.uid) })}
                          description={m.target ? <span className="bidi-isolate">{displayText(m.target)}</span> : undefined}
                          title={m.target ? `${displayText(m.name)}\n${displayText(m.target)}` : displayText(m.name)}
                        >
                          <span className="bidi-isolate">{displayText(m.name)}</span>
                          {m.type === 'group' ? <span className="ml-1.5 text-xs text-muted-foreground">group</span> : null}
                        </CheckRow>
                      ))}
                    </div>
                  ))
                )}
              </div>
              {errors.monitorUids ? (
                <p className="text-xs text-destructive" role="alert">
                  {errors.monitorUids}
                </p>
              ) : null}
            </div>

            <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="maint-active">Active</Label>
                <p className="text-xs text-muted-foreground">{draft.strategy === 'manual' ? 'On = under maintenance now.' : 'Paused windows never start.'}</p>
              </div>
              <Switch id="maint-active" checked={draft.active} onCheckedChange={(v) => set({ active: v })} />
            </div>

          </div>

          <DialogFooter className="mt-auto sm:items-center sm:justify-between">
            <p className={cn('min-h-5 text-sm text-destructive max-sm:order-last', !formError && Object.keys(errors).length === 0 && 'max-sm:hidden')} role="alert">
              {formError ?? (Object.keys(errors).length > 0 ? 'Please fix the highlighted fields.' : '')}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : initial ? 'Save' : 'Create window'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
