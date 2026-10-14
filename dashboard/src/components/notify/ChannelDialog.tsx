// Add / edit a notification channel: provider picker, provider fields rendered with the
// shared <FieldDefForm>, defaults, "apply to existing monitors" and a test button.
import { useId, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeftIcon, CircleAlertIcon, CircleCheckIcon, LockKeyholeIcon, SearchIcon, SendIcon } from 'lucide-react';
import { ApiError, errorMessage } from '@/api/client';
import {
  PROVIDER_CATEGORIES,
  PROVIDER_CATEGORY_LABELS,
  notifyApi,
  type ChannelInput,
  type NotificationChannel,
  type NotificationProvider,
  type WebhookPreset,
} from '@/api/notify';
import { FormMessage } from '@/components/AuthCard';
import { FieldDefForm, fieldValuesToConfig, initialFieldValues, validateFieldValues } from '@/components/forms/FieldDefForm';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { ProviderIcon } from './ProviderIcon';

/* ------------------------------------------------------------------ picker */

export function ProviderPicker({
  providers,
  hosted,
  onPick,
}: {
  providers: readonly NotificationProvider[];
  hosted: boolean;
  onPick: (p: NotificationProvider) => void;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const match = (p: NotificationProvider) => !query || p.label.toLowerCase().includes(query) || p.id.toLowerCase().includes(query);
    return PROVIDER_CATEGORIES.map((c) => ({
      category: c,
      items: providers.filter((p) => p.category === c && match(p)).sort((a, b) => a.label.localeCompare(b.label)),
    })).filter((g) => g.items.length > 0);
  }, [providers, query]);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search providers" aria-label="Search providers" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </InputGroup>
      <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-1" data-slot="provider-grid">
        {groups.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No provider matches “{displayText(q.slice(0, 40))}”.</p> : null}
        {groups.map((g) => (
          <section key={g.category} aria-label={PROVIDER_CATEGORY_LABELS[g.category]}>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{PROVIDER_CATEGORY_LABELS[g.category]}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {g.items.map((p) => {
                const disabled = hosted && !p.hostedAllowed;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(p)}
                    title={disabled ? `${displayText(p.label)} — not available on the hosted service` : displayText(p.label)}
                    className={cn(
                      'flex h-12 min-w-0 items-center gap-2 rounded-lg border bg-background px-2 text-left text-sm font-medium sm:gap-2.5 sm:px-2.5 outline-none transition-colors hover:border-foreground/20 hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/20',
                      disabled && 'cursor-not-allowed opacity-50 hover:border-border hover:bg-background',
                    )}
                  >
                    <ProviderIcon id={p.id} category={p.category} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{displayText(p.label)}</span>
                      {disabled ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                          <LockKeyholeIcon className="size-3" aria-hidden="true" />
                          Self-hosted only
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ dialog */

type TestState = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; message: string };

export function ChannelDialog({
  providers,
  channel,
  hosted,
  onClose,
  onSaved,
}: {
  providers: readonly NotificationProvider[];
  /** null = create */
  channel: NotificationChannel | null;
  hosted: boolean;
  onClose: () => void;
  onSaved: (c: NotificationChannel) => void;
}) {
  const initialProvider = channel ? (providers.find((p) => p.id === channel.type) ?? null) : null;
  const [provider, setProvider] = useState<NotificationProvider | null>(initialProvider);
  const [name, setName] = useState(channel?.name ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() => (initialProvider ? initialFieldValues(initialProvider.fields, channel?.config) : {}));
  const [isDefault, setIsDefault] = useState(channel?.isDefault ?? false);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [presetHelp, setPresetHelp] = useState<string | null>(null);
  const nameId = useId();
  const secretsSet = channel?.secretsSet ?? [];

  const pick = (p: NotificationProvider) => {
    setProvider(p);
    setValues(initialFieldValues(p.fields, null));
    setErrors({});
    setTest({ kind: 'idle' });
    if (!name.trim()) setName(p.label);
  };

  const validate = (): boolean => {
    if (!provider) return false;
    const fe = validateFieldValues(provider.fields, values, { hosted, secretsSet });
    const ne = name.trim() ? null : 'Give the channel a name.';
    setErrors(fe);
    setNameError(ne);
    return Object.keys(fe).length === 0 && !ne;
  };

  const payload = (): ChannelInput => ({
    type: provider?.id,
    name: name.trim(),
    config: provider ? fieldValuesToConfig(provider.fields, values, hosted) : {},
    isDefault,
  });

  const runTest = async () => {
    if (!validate()) return;
    setTest({ kind: 'testing' });
    try {
      // With `uid`, the server fills omitted secret fields from the stored channel.
      const r = await notifyApi.testUnsaved({ ...payload(), ...(channel ? { uid: channel.uid } : {}) });
      setTest(r.ok ? { kind: 'ok' } : { kind: 'error', message: r.error ?? 'Sending failed.' });
    } catch (err) {
      if (!mapFieldError(err)) setTest({ kind: 'error', message: errorMessage(err) || 'Sending failed.' });
      else setTest({ kind: 'idle' });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!provider || !validate()) return;
    setBusy(true);
    setSaveError(null);
    try {
      const body: ChannelInput = { ...payload(), ...(applyToExisting ? { applyToExisting: true } : {}) };
      if (channel) delete body.type;
      const saved = channel ? await notifyApi.updateChannel(channel.uid, body) : await notifyApi.createChannel(body);
      onSaved(saved);
    } catch (err) {
      if (!mapFieldError(err)) setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Shows a server validation error next to its field; false when it names no known field. */
  const mapFieldError = (err: unknown): boolean => {
    if (!(err instanceof ApiError) || !err.field || !provider) return false;
    const key = err.field.replace(/^config\./, '');
    if (key === 'name') {
      setNameError(err.message);
      return true;
    }
    if (provider.fields.some((f) => f.key === key)) {
      setErrors((e) => ({ ...e, [key]: err.message }));
      return true;
    }
    return false;
  };

  const applyPreset = (preset: WebhookPreset) => {
    if (!provider) return;
    const merged = { ...fieldValuesToConfig(provider.fields, values, hosted), ...preset.config };
    const next = initialFieldValues(provider.fields, merged);
    // keep secrets the user already typed; add the preset's header names as empty rows
    for (const f of provider.fields) if (f.secret && values[f.key] !== undefined) next[f.key] = values[f.key];
    if (preset.headerNames.length > 0 && provider.fields.some((f) => f.key === 'headers')) {
      const rows = Array.isArray(values.headers) ? (values.headers as Array<{ key: string; value: string }>) : [];
      next.headers = [...rows, ...preset.headerNames.filter((h) => !rows.some((r) => r.key === h)).map((key) => ({ key, value: '' }))];
    }
    setValues(next);
    setPresetHelp(preset.help || null);
  };

  const insertVar = (v: string) => {
    if (!provider?.fields.some((f) => f.key === 'bodyTemplate')) return;
    const cur = typeof values.bodyTemplate === 'string' ? values.bodyTemplate : '';
    change({ ...values, bodyTemplate: `${cur}{{${v}}}` });
  };

  const change = (v: Record<string, unknown>) => {
    setValues(v);
    if (test.kind !== 'idle' && test.kind !== 'testing') setTest({ kind: 'idle' });
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 sm:max-w-2xl" data-slot="channel-dialog">
        {!provider ? (
          <>
            <DialogHeader>
              <DialogTitle>Add notification channel</DialogTitle>
              <DialogDescription>Where should alerts go? Pick a service.</DialogDescription>
            </DialogHeader>
            {channel ? (
              <FormMessage>The provider “{displayText(channel.type)}” of this channel is no longer available.</FormMessage>
            ) : (
              <ProviderPicker providers={providers} hosted={hosted} onPick={pick} />
            )}
          </>
        ) : (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col gap-4" noValidate>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <ProviderIcon id={provider.id} category={provider.category} className="size-9" />
                <div className="flex min-w-0 flex-col gap-1">
                  <DialogTitle>{channel ? 'Edit channel' : `New ${displayText(provider.label)} channel`}</DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-x-2">
                    <span>{displayText(provider.label)}</span>
                    {!channel ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                        onClick={() => {
                          setProvider(null);
                          setTest({ kind: 'idle' });
                        }}
                      >
                        <ArrowLeftIcon className="size-3" aria-hidden="true" />
                        Change
                      </button>
                    ) : null}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-1">
              <div className="flex flex-col gap-2">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  value={name}
                  maxLength={100}
                  aria-invalid={nameError ? true : undefined}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                />
                {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
              </div>

              {provider.presets.length > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3" data-slot="presets">
                  <span className="text-xs font-medium text-muted-foreground">Start from a preset</span>
                  <div className="flex flex-wrap gap-1.5">
                    {provider.presets.map((p) => (
                      <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => applyPreset(p)}>
                        {displayText(p.label)}
                      </Button>
                    ))}
                  </div>
                  {presetHelp ? <p className="text-xs text-muted-foreground">{displayText(presetHelp)}</p> : null}
                </div>
              ) : null}

              <FieldDefForm fields={provider.fields} values={values} onChange={change} errors={errors} secretsSet={secretsSet} hosted={hosted} disabled={busy} />

              {provider.templateVars.length > 0 ? (
                <details className="group rounded-lg border px-3 py-2 text-sm" data-slot="template-vars">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">Template variables</summary>
                  <p className="mt-2 text-xs text-muted-foreground">Click to append a placeholder to the body template:</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {provider.templateVars.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => insertVar(v)}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/50"
                      >{`{{${v}}}`}</button>
                    ))}
                  </div>
                </details>
              ) : null}

              <div className="flex flex-col divide-y rounded-lg border">
                <label className="flex cursor-pointer items-start justify-between gap-4 p-3">
                  <span className="flex flex-col gap-0.5 text-sm">
                    <span className="font-medium">Default for new monitors</span>
                    <span className="text-xs text-muted-foreground">Pre-selected when you create a monitor.</span>
                  </span>
                  <Switch checked={isDefault} onCheckedChange={setIsDefault} />
                </label>
                <label className="flex cursor-pointer items-start justify-between gap-4 p-3">
                  <span className="flex flex-col gap-0.5 text-sm">
                    <span className="font-medium">Apply to all existing monitors</span>
                    <span className="text-xs text-muted-foreground">Links this channel to every monitor you own once, when saving.</span>
                  </span>
                  <Switch checked={applyToExisting} onCheckedChange={setApplyToExisting} />
                </label>
              </div>
            </div>

            {/* Outside the scrolling body: always visible next to the buttons. */}
            {test.kind === 'ok' || test.kind === 'error' || saveError ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                {test.kind === 'ok' ? (
                  <p className="flex items-center gap-2 rounded-lg border border-good/30 bg-good/[0.07] px-3 py-2 text-sm text-good-text" role="status" data-slot="test-result">
                    <CircleCheckIcon className="size-4 shrink-0" aria-hidden="true" />
                    Test notification sent. Check that it arrived.
                  </p>
                ) : test.kind === 'error' ? (
                  <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive" role="alert" data-slot="test-result">
                    <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="bidi-isolate max-h-24 min-w-0 overflow-y-auto break-words">Test failed: {displayText(test.message)}</span>
                  </p>
                ) : null}
                {saveError ? <FormMessage>{saveError}</FormMessage> : null}
              </div>
            ) : null}

            <DialogFooter className="mt-auto sm:items-center sm:justify-between">
              <Button type="button" variant="outline" onClick={() => void runTest()} disabled={test.kind === 'testing' || busy}>
                <SendIcon aria-hidden="true" />
                {test.kind === 'testing' ? 'Sending…' : 'Send test'}
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : channel ? 'Save changes' : 'Add channel'}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
