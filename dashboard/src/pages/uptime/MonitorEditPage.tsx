import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertCircleIcon, ArrowLeftIcon, ArrowRightIcon, CheckIcon, ChevronRightIcon, SaveIcon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import type { Site } from '@/api/types';
import { uptimeApi, type Monitor, type MonitorTypeInfo, type Tag, type UptimeLimits } from '@/api/uptime';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { FieldDefForm, initialFieldValues, validateFieldValues } from '@/components/forms/FieldDefForm';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CheckRow, FormField, TagsEditor, UnitInput } from '@/components/uptime/form-parts';
import { parentCandidates } from '@/components/uptime/lib';
import {
  buildMonitorPayload,
  CERT_TYPES,
  DOMAIN_TYPES,
  everyText,
  hasErrors,
  mapServerError,
  monitorToForm,
  newMonitorForm,
  PASSIVE_TYPES,
  validateMonitorForm,
  type CommonKey,
  type MonitorForm,
} from '@/components/uptime/monitor-form';
import { rememberPushUrl } from '@/components/uptime/push';
import { toast, Toaster } from '@/components/uptime/toast';
import { TypeIcon, TypePicker, unavailableReason } from '@/components/uptime/TypePicker';
import { useAuth, useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText, isSafeHostname } from '@/lib/safety';
import { cn } from '@/lib/utils';

const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function MonitorEditPage() {
  const { uid } = useParams();
  const [params, setParams] = useSearchParams();
  const editing = uid !== undefined;
  const canManage = useCanManageSites();
  const { user } = useAuth();
  const hosted = user?.role === 'member';
  const types = useApi((signal) => uptimeApi.types(signal), []);
  const sites = useApi((signal) => api.listSites(signal), []);
  const existing = useApi((signal) => uptimeApi.getMonitor(uid ?? '', signal), [uid], editing && UID_RE.test(uid ?? ''));

  const typeName = editing ? existing.data?.type : (params.get('type') ?? undefined);
  const typeInfo = types.data?.types.find((t) => t.type === typeName);
  const siteParam = params.get('site') ?? '';
  const site = sites.data?.find((s) => s.id === siteParam);

  useEffect(() => {
    document.title = `${editing ? 'Edit monitor' : 'New monitor'} – PTR Analytics`;
    return () => {
      document.title = 'PTR Analytics';
    };
  }, [editing]);

  if (!canManage) {
    return (
      <Card>
        <EmptyState title="Read-only access">
          <p>Your account can view monitors but not change them.</p>
        </EmptyState>
      </Card>
    );
  }
  const error = types.error ?? sites.error ?? (editing ? existing.error : null);
  if (error) {
    return (
      <Card>
        <ErrorState
          message={error}
          onRetry={() => {
            types.reload();
            sites.reload();
            existing.reload();
          }}
        />
      </Card>
    );
  }
  if (!types.data || !sites.data || (editing && !existing.data)) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (!editing && !typeName) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="New monitor"
          description={site ? <span className="bidi-isolate">For {displayText(site.name)} · choose what to check</span> : 'Choose what to check'}
          actions={
            <Link to={site ? `/sites/${encodeURIComponent(site.id)}/uptime` : '/uptime'} className={cn(buttonVariants({ variant: 'outline' }), 'bg-background')}>
              Cancel
            </Link>
          }
        />
        <TypePicker
          types={types.data.types}
          hosted={hosted}
          onPick={(t) =>
            setParams((p) => {
              const n = new URLSearchParams(p);
              n.set('type', t);
              return n;
            })
          }
        />
      </div>
    );
  }

  if (!typeInfo) {
    return (
      <Card>
        <EmptyState title="Unknown monitor type">
          <p>
            This monitor type is not available.{' '}
            <Link to={editing ? '/uptime' : `/monitors/new${siteParam ? `?site=${encodeURIComponent(siteParam)}` : ''}`} className="font-medium text-foreground underline underline-offset-4">
              {editing ? 'Back to monitors' : 'Pick another type'}
            </Link>
          </p>
        </EmptyState>
      </Card>
    );
  }

  const reason = !editing ? unavailableReason(typeInfo, hosted) : null;
  return (
    <MonitorEditor
      key={existing.data?.uid ?? `new-${typeInfo.type}`}
      type={typeInfo}
      limits={types.data.limits}
      sites={sites.data}
      monitor={existing.data ?? null}
      initialSiteId={siteParam && sites.data.some((s) => s.id === siteParam) ? siteParam : sites.data.length === 1 ? sites.data[0]!.id : ''}
      prefillUrl={params.get('url')}
      cloned={params.get('cloned') === '1'}
      hosted={hosted}
      unavailable={reason}
      onChangeType={() =>
        setParams((p) => {
          const n = new URLSearchParams(p);
          n.delete('type');
          return n;
        })
      }
    />
  );
}

function Section({ id, title, description, children, icon }: { id?: string; title: string; description?: ReactNode; children: ReactNode; icon?: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-20 gap-5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  );
}

function SwitchRow({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useMemo(() => `sw-${label.replace(/\W+/g, '-').toLowerCase()}`, [label]);
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

function hostFromUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const h = new URL(v).hostname;
    return h && h.length <= 100 ? h : null;
  } catch {
    return null;
  }
}

function MonitorEditor({
  type,
  limits,
  sites,
  monitor,
  initialSiteId,
  prefillUrl,
  cloned,
  hosted,
  unavailable,
  onChangeType,
}: {
  type: MonitorTypeInfo;
  limits: UptimeLimits;
  sites: Site[];
  monitor: Monitor | null;
  initialSiteId: string;
  prefillUrl: string | null;
  cloned: boolean;
  hosted: boolean;
  unavailable: string | null;
  onChangeType: () => void;
}) {
  const navigate = useNavigate();
  const editing = monitor !== null;
  const [form, setForm] = useState<MonitorForm>(() => (monitor ? monitorToForm(monitor) : newMonitorForm(type, limits, initialSiteId)));
  const urlField = type.fields.find((f) => f.kind === 'url');
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v = initialFieldValues(type.fields, monitor?.config);
    if (!monitor && urlField && prefillUrl && /^https?:\/\//i.test(prefillUrl) && prefillUrl.length <= 2048) v[urlField.key] = prefillUrl;
    return v;
  });
  const [commonErrors, setCommonErrors] = useState<Partial<Record<CommonKey, string>>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [tagsExtra, setTagsExtra] = useState<Tag[]>([]);
  const channelsTouched = useRef(editing);
  const submitted = useRef(false);

  const tags = useApi((signal) => uptimeApi.listTags(signal), []);
  const channels = useApi((signal) => uptimeApi.listChannels(signal), []);
  const siteMonitors = useApi((signal) => uptimeApi.siteMonitors(form.siteId, signal), [form.siteId], form.siteId !== '');
  const allTags = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of [...(tags.data ?? []), ...tagsExtra]) m.set(t.uid, t);
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tags.data, tagsExtra]);
  const parents = useMemo(() => parentCandidates(siteMonitors.data ?? [], form.siteId, monitor?.uid), [siteMonitors.data, form.siteId, monitor?.uid]);

  // new monitors: preselect default channels once loaded
  useEffect(() => {
    if (channelsTouched.current || !channels.data) return;
    const defaults = channels.data.filter((c) => c.isDefault && c.active).map((c) => c.uid);
    if (defaults.length) setForm((f) => ({ ...f, channelUids: defaults }));
  }, [channels.data]);

  // move focus to the first invalid control after a failed submit
  useEffect(() => {
    if (!submitted.current) return;
    submitted.current = false;
    const el = document.querySelector<HTMLElement>('[data-slot="monitor-editor"] [aria-invalid="true"]');
    el?.focus();
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [commonErrors, fieldErrors]);

  const set = <K extends keyof MonitorForm>(k: K, v: MonitorForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const passive = PASSIVE_TYPES.has(type.type);
  const derivedName = urlField ? hostFromUrl(values[urlField.key]) : null;
  const secretsSet = monitor?.secretsSet ?? [];

  const submit = async (checkAfter: boolean) => {
    const f = { ...form, name: form.name.trim() || (derivedName && isSafeHostname(derivedName) ? derivedName : form.name) };
    const ce = validateMonitorForm(f, type.type, limits);
    const fe = validateFieldValues(type.fields, values, { hosted, secretsSet });
    setCommonErrors(ce);
    setFieldErrors(fe);
    setFormError(null);
    if (hasErrors({ common: ce, fields: fe })) {
      submitted.current = true;
      return;
    }
    if (f.name !== form.name) setForm(f);
    setBusy(checkAfter ? 'check' : 'save');
    try {
      const body = buildMonitorPayload(f, type, values, { hosted, create: !editing });
      let saved: Monitor | null;
      if (editing) {
        saved = (await uptimeApi.updateMonitor(monitor.uid, body)) ?? monitor;
      } else {
        saved = await uptimeApi.createMonitor(f.siteId, body);
        if (saved.pushUrl) rememberPushUrl(saved.uid, saved.pushUrl);
      }
      if (checkAfter && saved.active && !PASSIVE_TYPES.has(type.type)) {
        try {
          await uptimeApi.checkMonitor(saved.uid);
        } catch (err) {
          toast(`Saved, but the check could not start: ${errorMessage(err)}`, 'error');
        }
      }
      toast(editing ? 'Monitor saved' : 'Monitor created');
      navigate(`/monitors/${encodeURIComponent(saved.uid)}`);
    } catch (err) {
      const mapped = mapServerError(err, type.fields, 'Could not save the monitor.');
      setCommonErrors(mapped.common);
      setFieldErrors(mapped.fields);
      setFormError(mapped.form);
      submitted.current = hasErrors(mapped);
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(false);
  };

  const cancelHref = editing ? `/monitors/${encodeURIComponent(monitor.uid)}` : initialSiteId ? `/sites/${encodeURIComponent(initialSiteId)}/uptime` : '/uptime';
  const errorCount = Object.keys(commonErrors).length + Object.keys(fieldErrors).length;
  const siteName = sites.find((s) => s.id === form.siteId)?.name;

  return (
    <form className="mx-auto flex w-full max-w-3xl flex-col gap-6" onSubmit={onSubmit} noValidate data-slot="monitor-editor">
      <div className="flex flex-col gap-2">
        <Link to={cancelHref} className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          {editing ? 'Back to monitor' : 'Back'}
        </Link>
        <PageHeader
          title={editing ? <span className="bidi-isolate">Edit {displayText(monitor.name)}</span> : `New ${type.label} monitor`}
          description={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <TypeIcon type={type.type} className="size-3.5" />
                {type.label}
              </span>
              {siteName ? <span className="bidi-isolate">· {displayText(siteName)}</span> : null}
              {!editing ? (
                <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={onChangeType}>
                  Change type
                </button>
              ) : null}
            </span>
          }
        />
      </div>

      {cloned ? (
        <Alert>
          <CheckIcon aria-hidden="true" />
          <AlertTitle>Monitor cloned</AlertTitle>
          <AlertDescription>This is a copy. Review the settings and save it. Push monitors get a new push URL.</AlertDescription>
        </Alert>
      ) : null}
      {unavailable ? (
        <Alert className="border-warn/40 bg-warn/8">
          <AlertCircleIcon className="text-warn" aria-hidden="true" />
          <AlertTitle>{unavailable}</AlertTitle>
          <AlertDescription>Pick another monitor type.</AlertDescription>
        </Alert>
      ) : null}

      <Section title="General">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="Name" required error={commonErrors.name} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={form.name}
                maxLength={100}
                placeholder={derivedName ?? 'My website'}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(e) => set('name', e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Site" required error={commonErrors.siteId} hint={editing ? 'Monitors stay with their site. Clone the monitor to use it for another site.' : undefined}>
            {({ id, describedBy, invalid }) => (
              <Select<string> value={form.siteId || null} onValueChange={(v) => setForm((f) => ({ ...f, siteId: v ?? '', parentUid: '' }))} disabled={editing}>
                <SelectTrigger id={id} className="w-full" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                  <SelectValue placeholder="Select a site">{(v: string | null) => <span className="bidi-isolate truncate">{displayText(sites.find((s) => s.id === v)?.name ?? 'Select a site')}</span>}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start">
                  {sites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="bidi-isolate truncate">{displayText(s.name)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label="Group" error={commonErrors.parentUid} hint={parents.length === 0 ? 'Create a monitor of type “Group” to nest monitors.' : 'The group’s status reflects its monitors.'}>
            {({ id, describedBy, invalid }) => (
              <Select<string> value={form.parentUid || '__none'} onValueChange={(v) => set('parentUid', !v || v === '__none' ? '' : v)} disabled={parents.length === 0}>
                <SelectTrigger id={id} className="w-full" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                  <SelectValue>{(v: string) => (v === '__none' ? 'No group' : <span className="bidi-isolate truncate">{displayText(parents.find((p) => p.uid === v)?.name ?? 'Unknown group')}</span>)}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} align="start">
                  <SelectItem value="__none">No group</SelectItem>
                  {parents.map((p) => (
                    <SelectItem key={p.uid} value={p.uid}>
                      <span className="bidi-isolate truncate">{displayText(p.name)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField label="Description" error={commonErrors.description} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={2}
                maxLength={500}
                value={form.description}
                placeholder="Optional notes for your team"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(e) => set('description', e.target.value)}
              />
            )}
          </FormField>
        </div>
      </Section>

      {type.fields.length > 0 ? (
        <Section title={`${type.label} settings`} description={type.description} icon={<TypeIcon type={type.type} className="size-4 text-muted-foreground" />}>
          <FieldDefForm fields={type.fields} values={values} onChange={setValues} errors={fieldErrors} secretsSet={secretsSet} hosted={hosted} disabled={busy !== null} />
        </Section>
      ) : null}

      <Section
        title="Checks"
        description={
          type.type === 'push'
            ? 'The monitor goes down when no push arrives within the interval.'
            : `Minimum interval ${limits.minIntervalS} s, timeout up to ${limits.maxTimeoutMs / 1000} s.`
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label={type.type === 'push' ? 'Expected push interval' : 'Check interval'} required error={commonErrors.intervalS} hint={everyText(form.intervalS)}>
            {({ id, describedBy, invalid }) => (
              <UnitInput
                id={id}
                unit="s"
                min={limits.minIntervalS}
                max={86_400}
                value={form.intervalS}
                invalid={invalid}
                describedBy={describedBy}
                onChange={(v) => setForm((f) => ({ ...f, intervalS: v, retryIntervalS: f.retryIntervalS === f.intervalS ? v : f.retryIntervalS }))}
              />
            )}
          </FormField>
          {!passive ? (
            <FormField label="Timeout" required error={commonErrors.timeoutS} hint="Per check attempt, at most 80% of the interval.">
              {({ id, describedBy, invalid }) => (
                <UnitInput id={id} unit="s" min={0.5} max={limits.maxTimeoutMs / 1000} step={0.5} value={form.timeoutS} invalid={invalid} describedBy={describedBy} onChange={(v) => set('timeoutS', v)} />
              )}
            </FormField>
          ) : null}
          <FormField label="Retries" error={commonErrors.maxRetries} hint={`Failed checks before the monitor is marked down (0–${limits.maxRetries}).`}>
            {({ id, describedBy, invalid }) => (
              <UnitInput id={id} unit="×" min={0} max={limits.maxRetries} value={form.maxRetries} invalid={invalid} describedBy={describedBy} onChange={(v) => set('maxRetries', v)} />
            )}
          </FormField>
          <FormField label="Retry interval" error={commonErrors.retryIntervalS} hint={form.retryIntervalS ? `While retrying, check ${everyText(form.retryIntervalS)}.` : undefined}>
            {({ id, describedBy, invalid }) => (
              <UnitInput id={id} unit="s" min={limits.minIntervalS} max={86_400} value={form.retryIntervalS} invalid={invalid} describedBy={describedBy} onChange={(v) => set('retryIntervalS', v)} />
            )}
          </FormField>
          <FormField label="Resend notification" error={commonErrors.resendEvery} hint={form.resendEvery ? `Repeat the down notification every ${form.resendEvery} failed checks.` : 'Off — notify once per outage.'}>
            {({ id, describedBy, invalid }) => (
              <UnitInput id={id} unit="checks" min={0} max={1000} value={form.resendEvery} invalid={invalid} describedBy={describedBy} onChange={(v) => set('resendEvery', v)} />
            )}
          </FormField>
        </div>
        <SwitchRow
          label="Upside-down mode"
          description="Treat a successful check as down and a failing one as up (e.g. to make sure a port stays closed)."
          checked={form.upsideDown}
          onChange={(v) => set('upsideDown', v)}
        />
      </Section>

      <Section id="notifications" title="Notifications">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Channels</span>
            <Link to="/notifications" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              Manage channels
              <ChevronRightIcon className="size-3.5" aria-hidden="true" />
            </Link>
          </div>
          {channels.error ? (
            <p className="text-sm text-muted-foreground">Channels could not be loaded.</p>
          ) : !channels.data ? (
            <Skeleton className="h-16 w-full" />
          ) : channels.data.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              No notification channels yet.{' '}
              <Link to="/notifications" className="font-medium text-foreground underline underline-offset-4">
                Add e-mail, Slack, Discord, webhooks…
              </Link>
            </p>
          ) : (
            <div className="grid gap-0.5 rounded-lg border p-1 sm:grid-cols-2">
              {channels.data.map((c) => (
                <CheckRow
                  key={c.uid}
                  checked={form.channelUids.includes(c.uid)}
                  onChange={(on) => {
                    channelsTouched.current = true;
                    set('channelUids', on ? [...form.channelUids, c.uid] : form.channelUids.filter((x) => x !== c.uid));
                  }}
                  description={[c.type, c.isDefault ? 'default' : '', c.active ? '' : 'paused'].filter(Boolean).join(' · ')}
                >
                  <span className="bidi-isolate">{displayText(c.name)}</span>
                </CheckRow>
              ))}
            </div>
          )}
          {commonErrors.channelUids ? <p className="text-xs text-destructive">{commonErrors.channelUids}</p> : null}
        </div>
        {CERT_TYPES.has(type.type) ? (
          <SwitchRow label="Certificate expiry" description="Notify 21, 14, 7, 3 and 1 days before the TLS certificate expires." checked={form.certNotify} onChange={(v) => set('certNotify', v)} />
        ) : null}
        {DOMAIN_TYPES.has(type.type) && type.type !== 'domain' ? (
          <SwitchRow label="Domain expiry" description="Look up the domain registration (RDAP) and notify before it expires." checked={form.domainNotify} onChange={(v) => set('domainNotify', v)} />
        ) : null}
      </Section>

      <Section title="Tags" description="Group and filter monitors; tags can carry a value (e.g. env: production).">
        <TagsEditor tags={allTags} value={form.tags} onChange={(v) => set('tags', v)} onTagCreated={(t) => setTagsExtra((x) => [...x, t])} />
        {commonErrors.tags ? <p className="text-xs text-destructive">{commonErrors.tags}</p> : null}
      </Section>

      <Card size="sm" className="px-4">
        <SwitchRow
          label={editing ? 'Active' : 'Start monitoring right away'}
          description={form.active ? 'Checks run on schedule.' : 'Paused: no checks and no notifications.'}
          checked={form.active}
          onChange={(v) => set('active', v)}
        />
      </Card>

      {formError || errorCount > 0 ? (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>{formError ? 'Could not save' : `Please fix ${errorCount === 1 ? 'one field' : `${errorCount} fields`}`}</AlertTitle>
          {formError ? <AlertDescription>{formError}</AlertDescription> : null}
        </Alert>
      ) : null}

      <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/85 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <Link to={cancelHref} className={cn(buttonVariants({ variant: 'ghost' }), 'mr-auto')}>
          Cancel
        </Link>
        {!passive ? (
          <Button type="button" variant="outline" className="bg-background" disabled={busy !== null || unavailable !== null || !form.active} onClick={() => void submit(true)}>
            <ArrowRightIcon aria-hidden="true" />
            {busy === 'check' ? 'Saving…' : 'Save & check now'}
          </Button>
        ) : null}
        <Button type="submit" disabled={busy !== null || unavailable !== null}>
          <SaveIcon aria-hidden="true" />
          {busy === 'save' ? 'Saving…' : editing ? 'Save' : 'Create monitor'}
        </Button>
      </div>
      <Toaster />
    </form>
  );
}
