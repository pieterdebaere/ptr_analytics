import { useId, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { CheckIcon, ImageUpIcon, MonitorIcon, MoonIcon, SunIcon, Trash2Icon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { LOGO_TYPES, REFRESH_MAX_S, REFRESH_MIN_S, SLUG_MAX, checkLogoFile, safeAccent, statusApi, type StatusPage, type StatusTheme } from '@/api/status';
import type { Site } from '@/api/types';
import { FormMessage } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { MARKDOWN_MAX, TITLE_MAX, type Draft, type DraftErrors } from './draft';
import { MarkdownField } from './MarkdownField';

export const ACCENT_PRESETS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0f172a'] as const;

const NO_TRACKING = '__none__';
const REFRESH_OPTIONS = [30, 60, 120, 300, 600, 1800, 3600];

function refreshLabel(s: number): string {
  if (s < 60) return `${s} seconds`;
  if (s < 3600) return `${Math.round(s / 60)} ${s === 60 ? 'minute' : 'minutes'}`;
  return '1 hour';
}

export function SettingRow({ title, description, children, htmlFor }: { title: string; description?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 flex-col gap-0.5">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm font-medium">
            {title}
          </Label>
        ) : (
          <span className="text-sm font-medium">{title}</span>
        )}
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function SwitchRow({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <SettingRow title={title} description={description} htmlFor={id}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </SettingRow>
  );
}

export function GeneralTab({
  draft,
  update,
  errors,
  page,
  sites,
  origin,
  onPageChange,
  readOnly,
}: {
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  errors: DraftErrors;
  page: StatusPage;
  sites: readonly Site[];
  origin: string;
  onPageChange: (p: StatusPage) => void;
  readOnly: boolean;
}) {
  const titleId = useId();
  const slugId = useId();
  const refreshOptions = REFRESH_OPTIONS.includes(draft.refreshS) ? REFRESH_OPTIONS : [...REFRESH_OPTIONS, draft.refreshS].sort((a, b) => a - b);
  const analyticsSite = sites.find((s) => s.id === draft.analyticsSiteId);

  return (
    <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Page</CardTitle>
          <CardDescription>Title, address and the text around your services.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={titleId}>Title</Label>
              <Input id={titleId} value={draft.title} maxLength={TITLE_MAX} aria-invalid={errors.title ? true : undefined} onChange={(e) => update({ title: e.target.value })} />
              {errors.title ? <p className="text-xs text-destructive">{errors.title}</p> : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={slugId}>Address</Label>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>/status/</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id={slugId}
                  value={draft.slug}
                  maxLength={SLUG_MAX}
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-invalid={errors.slug ? true : undefined}
                  onChange={(e) => update({ slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                />
              </InputGroup>
              <p className={cn('truncate text-xs', errors.slug ? 'text-destructive' : 'text-muted-foreground')} data-slot="slug-hint">
                {errors.slug ?? `${origin}/status/${draft.slug}`}
              </p>
            </div>
          </div>
          <MarkdownField
            label="Description"
            value={draft.description}
            onChange={(v) => update({ description: v })}
            maxLength={MARKDOWN_MAX}
            placeholder="Live status of the Acme API and website."
            error={errors.description}
          />
          <MarkdownField
            label="Footer"
            value={draft.footer}
            onChange={(v) => update({ footer: v })}
            maxLength={MARKDOWN_MAX}
            rows={3}
            placeholder="Questions? [Contact support](mailto:support@example.com)"
            error={errors.footer}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Logo, colour and theme of the public page.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          <SettingRow title="Logo" description="PNG, JPEG or WebP, at most 512 KB. Shown next to the title.">
            <LogoField page={page} onPageChange={onPageChange} disabled={readOnly} />
          </SettingRow>
          <SettingRow title="Accent colour" description="Used for the top bar and links.">
            <AccentField value={draft.accent} onChange={(accent) => update({ accent })} disabled={readOnly} />
          </SettingRow>
          <SettingRow title="Theme" description="Independent of your dashboard theme.">
            <ToggleGroup
              value={[draft.theme]}
              onValueChange={(v: unknown[]) => {
                const t = v[0];
                if (t === 'auto' || t === 'light' || t === 'dark') update({ theme: t as StatusTheme });
              }}
              variant="outline"
              spacing={0}
              aria-label="Theme"
            >
              <ToggleGroupItem value="auto" aria-label="Automatic">
                <MonitorIcon aria-hidden="true" />
                Auto
              </ToggleGroupItem>
              <ToggleGroupItem value="light" aria-label="Light">
                <SunIcon aria-hidden="true" />
                Light
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" aria-label="Dark">
                <MoonIcon aria-hidden="true" />
                Dark
              </ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>
          <SwitchRow title="Show tags" description="Monitor tags next to the service names." checked={draft.showTags} onChange={(v) => update({ showTags: v })} />
          <SwitchRow
            title="Show certificate expiry"
            description="Days until the TLS certificate of HTTPS monitors expires."
            checked={draft.showCertExpiry}
            onChange={(v) => update({ showCertExpiry: v })}
          />
          <SwitchRow title="Show “Powered by PTR Analytics”" checked={draft.showPoweredBy} onChange={(v) => update({ showPoweredBy: v })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Visibility</CardTitle>
          <CardDescription>Who can see the page and how it behaves.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          <SwitchRow title="Published" description="Unpublished pages answer “not found” to visitors." checked={draft.published} onChange={(v) => update({ published: v })} />
          <SwitchRow
            title="Hide from search engines"
            description="Adds a noindex robots tag."
            checked={draft.noindex}
            onChange={(v) => update({ noindex: v })}
          />
          <SettingRow title="Auto refresh" description="How often an open page reloads its data (paused in background tabs).">
            <Select value={String(draft.refreshS)} onValueChange={(v) => update({ refreshS: Math.min(REFRESH_MAX_S, Math.max(REFRESH_MIN_S, Number(v))) })}>
              <SelectTrigger className="w-36" aria-label="Auto refresh">
                <SelectValue>{(v: string) => refreshLabel(Number(v))}</SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {refreshOptions.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {refreshLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow title="Track visits" description="Count page views of this status page with PTR Analytics (cookieless).">
            <Select value={draft.analyticsSiteId ?? NO_TRACKING} onValueChange={(v) => update({ analyticsSiteId: v && v !== NO_TRACKING ? String(v) : null })}>
              <SelectTrigger className="w-48" aria-label="Track visits with site">
                <SelectValue>
                  {(v: string) => (v !== NO_TRACKING ? <span className="bidi-isolate truncate">{displayText(analyticsSite?.name ?? 'Unknown site')}</span> : "Don't track")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectItem value={NO_TRACKING}>Don&apos;t track</SelectItem>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="bidi-isolate truncate">{displayText(s.name)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </CardContent>
      </Card>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ accent */

export function AccentField({ value, onChange, disabled }: { value: string | null; onChange: (v: string | null) => void; disabled?: boolean }) {
  const [hex, setHex] = useState(value ?? '');
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setHex(value ?? '');
  }
  const commit = (v: string) => {
    const norm = v.startsWith('#') ? v : `#${v}`;
    const ok = safeAccent(norm);
    if (ok) onChange(ok);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Accent presets">
        {ACCENT_PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={value === c}
            aria-label={c}
            disabled={disabled}
            onClick={() => onChange(c)}
            className="flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-foreground/60"
            style={{ backgroundColor: c } as CSSProperties}
          >
            {value === c ? <CheckIcon className="size-3.5 text-white" aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <label className="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-lg border" title="Pick a colour">
          <span className="absolute inset-0" style={{ backgroundColor: value ?? 'transparent' } as CSSProperties} aria-hidden="true" />
          <input
            type="color"
            value={value ?? '#2563eb'}
            disabled={disabled}
            aria-label="Pick a colour"
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            onChange={(e) => onChange(safeAccent(e.target.value))}
          />
        </label>
        <Input
          value={hex}
          maxLength={7}
          placeholder="#2563eb"
          aria-label="Accent colour (hex)"
          className="w-24 font-mono"
          onChange={(e) => {
            setHex(e.target.value);
            commit(e.target.value.trim());
          }}
          onBlur={() => setHex(value ?? '')}
        />
        {value ? (
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ logo */

export function LogoField({ page, onPageChange, disabled }: { page: StatusPage; onPageChange: (p: StatusPage) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    const problem = await checkLogoFile(file);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const p = await statusApi.uploadLogo(page.uid, file);
      onPageChange(p ?? (await statusApi.get(page.uid)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await statusApi.deleteLogo(page.uid);
      onPageChange(p ?? (await statusApi.get(page.uid)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex items-center gap-2">
        <span className="flex h-10 w-24 items-center justify-center overflow-hidden rounded-lg border border-dashed bg-muted/40" data-slot="logo-preview">
          {page.logoUrl ? <img src={page.logoUrl} alt="Current logo" className="max-h-8 max-w-20 object-contain" /> : <span className="text-[11px] text-muted-foreground">No logo</span>}
        </span>
        <input ref={input} type="file" accept={LOGO_TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} />
        <Button type="button" variant="outline" disabled={busy || disabled} onClick={() => input.current?.click()}>
          <ImageUpIcon aria-hidden="true" />
          {busy ? 'Uploading…' : page.logoUrl ? 'Replace' : 'Upload'}
        </Button>
        {page.logoUrl ? (
          <Button type="button" variant="ghost" size="icon" disabled={busy || disabled} onClick={() => void remove()} aria-label="Remove logo">
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {error ? <FormMessage className="text-xs">{error}</FormMessage> : null}
    </div>
  );
}
