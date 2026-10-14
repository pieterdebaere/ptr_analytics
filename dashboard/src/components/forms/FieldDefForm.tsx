// Dynamic form renderer for server-described fields (FieldDef, docs/SPEC.md §8.3):
// monitor type settings (GET /api/uptime/types) and notification channels
// (GET /api/notification-providers). Controlled: the parent owns `values`.
//
// Secret fields are write-only: never prefilled; when the server reports them in
// `secretsSet` they show "•••• set — leave empty to keep" and a Clear action
// (value `null` = clear on save). See ./field-values.ts for the value shapes.
import { useId, useState, type ReactNode } from 'react';
import { ChevronRightIcon, EyeIcon, EyeOffIcon, PlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from 'lucide-react';
import type { FieldDef } from '@/api/uptime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { groupFields, isFieldVisible, isSecretField, isStatusCodeRange, type FieldValues, type KeyValueRow } from './field-values';

export {
  fieldValuesToConfig,
  groupFields,
  initialFieldValues,
  isFieldVisible,
  isSecretField,
  validateFieldValues,
  visibleFields,
  type FieldValues,
  type KeyValueRow,
} from './field-values';

export interface FieldDefFormProps {
  fields: FieldDef[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  /** Error message per field key (client-side or mapped from the server). */
  errors?: Record<string, string>;
  /** Secret field keys that have a stored value (from the API's `secretsSet`). */
  secretsSet?: string[];
  /** Hosted mode member: hides `selfHostedOnly` fields. */
  hosted?: boolean;
  disabled?: boolean;
}

/** Kinds that take the full row in the two-column layout. */
const WIDE_KINDS = new Set(['url', 'textarea', 'list', 'keyvalue', 'statuscodes', 'boolean']);

export function FieldDefForm({ fields, values, onChange, errors = {}, secretsSet = [], hosted = false, disabled = false }: FieldDefFormProps) {
  const prefix = useId();
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v });
  const groups = groupFields(fields)
    .map((g) => ({ ...g, fields: g.fields.filter((f) => isFieldVisible(f, fields, values, hosted)) }))
    .filter((g) => g.fields.length > 0);

  const renderFields = (list: FieldDef[]) => (
    <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">
      {list.map((f) => (
        <FieldRow
          key={f.key}
          id={`${prefix}-${f.key}`}
          field={f}
          value={values[f.key]}
          onChange={(v) => set(f.key, v)}
          error={errors[f.key]}
          isSet={secretsSet.includes(f.key)}
          disabled={disabled}
          wide={WIDE_KINDS.has(f.kind) || list.length === 1}
        />
      ))}
    </div>
  );

  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-6" data-slot="fielddef-form">
      {groups.map((g) =>
        g.group === null ? (
          <div key="__default">{renderFields(g.fields)}</div>
        ) : /advanced/i.test(g.group) ? (
          <CollapsibleGroup key={g.group} title={g.group} forceOpen={g.fields.some((f) => errors[f.key])}>
            {renderFields(g.fields)}
          </CollapsibleGroup>
        ) : (
          <fieldset key={g.group} className="flex min-w-0 flex-col gap-4 border-t pt-5 first:border-t-0 first:pt-0">
            <legend className="float-left mb-4 w-full text-[13px] font-semibold tracking-tight text-foreground">{g.group}</legend>
            {renderFields(g.fields)}
          </fieldset>
        ),
      )}
    </div>
  );
}

function CollapsibleGroup({ title, forceOpen, children }: { title: string; forceOpen: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open || forceOpen;
  return (
    <section className="flex flex-col gap-4 border-t pt-4 first:border-t-0 first:pt-0">
      <button
        type="button"
        className="-mx-1 flex h-8 items-center gap-1.5 self-start rounded-md px-1 text-[13px] font-semibold tracking-tight outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRightIcon className={cn('size-4 text-muted-foreground transition-transform', shown && 'rotate-90')} aria-hidden="true" />
        {title}
      </button>
      <div id={id} hidden={!shown}>
        {children}
      </div>
    </section>
  );
}

interface FieldRowProps {
  id: string;
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  isSet: boolean;
  disabled: boolean;
  wide: boolean;
}

function FieldRow({ id, field: f, value, onChange, error, isSet, disabled, wide }: FieldRowProps) {
  const helpId = `${id}-help`;
  const errId = `${id}-error`;
  const describedBy = [f.help ? helpId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const common = { id, disabled, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy };

  if (f.kind === 'boolean') {
    return (
      <div className={cn('flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5', wide && 'sm:col-span-2')} data-field={f.key}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label htmlFor={id} className="leading-snug">
            {f.label}
          </Label>
          {f.help ? (
            <p id={helpId} className="text-xs text-muted-foreground">
              {f.help}
            </p>
          ) : null}
          {error ? (
            <p id={errId} className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(c) => onChange(c)}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="mt-0.5"
        />
      </div>
    );
  }

  let control: ReactNode;
  const secret = isSecretField(f);
  if (secret && f.kind !== 'keyvalue') {
    control = <SecretInput {...common} field={f} value={value} onChange={onChange} isSet={isSet} />;
  } else {
    switch (f.kind) {
      case 'number':
        control = (
          <Input
            {...common}
            type="number"
            inputMode="decimal"
            min={f.min}
            max={f.max}
            placeholder={f.placeholder}
            value={typeof value === 'number' && Number.isFinite(value) ? String(value) : ''}
            onChange={(e) => {
              const raw = e.target.value;
              const n = raw === '' ? undefined : Number(raw);
              onChange(n === undefined || Number.isNaN(n) ? undefined : n);
            }}
          />
        );
        break;
      case 'select':
        control = (
          <Select<string> value={typeof value === 'string' ? value : null} onValueChange={(v) => onChange(v ?? '')} disabled={disabled}>
            <SelectTrigger id={id} className="w-full" aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
              <SelectValue placeholder={f.placeholder ?? 'Select…'}>
                {(v: string | null) => f.options?.find((o) => o.value === v)?.label ?? (v || f.placeholder || 'Select…')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} align="start">
              {(f.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
        break;
      case 'textarea':
        control = (
          <Textarea
            {...common}
            rows={4}
            maxLength={f.maxLength}
            placeholder={f.placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono text-[13px] md:text-[13px]"
          />
        );
        break;
      case 'list':
        control = (
          <Textarea
            {...common}
            rows={3}
            placeholder={f.placeholder ?? 'One entry per line'}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(e) => onChange(e.target.value.split('\n'))}
            onBlur={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
          />
        );
        break;
      case 'keyvalue':
        control = <KeyValueEditor id={id} field={f} value={value} onChange={onChange} isSet={isSet} disabled={disabled} invalid={!!error} />;
        break;
      case 'statuscodes':
        control = <StatusCodesEditor id={id} value={value} onChange={onChange} disabled={disabled} invalid={!!error} describedBy={describedBy} />;
        break;
      default:
        control = (
          <Input
            {...common}
            type={f.kind === 'url' ? 'url' : 'text'}
            inputMode={f.kind === 'url' ? 'url' : undefined}
            autoComplete="off"
            spellCheck={f.kind === 'text' ? undefined : false}
            maxLength={f.maxLength}
            placeholder={f.placeholder}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  }

  const labelFor = f.kind === 'keyvalue' || f.kind === 'statuscodes' ? undefined : id;
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', wide && 'sm:col-span-2')} data-field={f.key}>
      <div className="flex items-center gap-2">
        {labelFor ? (
          <Label htmlFor={labelFor}>
            {f.label}
            {f.required ? <span className="text-destructive" aria-hidden="true">*</span> : null}
          </Label>
        ) : (
          <span id={`${id}-label`} className="text-sm leading-none font-medium select-none">
            {f.label}
            {f.required ? <span className="text-destructive" aria-hidden="true">*</span> : null}
          </span>
        )}
        {secret ? (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
            write-only
          </Badge>
        ) : null}
      </div>
      {control}
      {f.help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {f.help}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------- secret input ---------------- */

function SecretInput({
  id,
  field: f,
  value,
  onChange,
  isSet,
  disabled,
  ...aria
}: {
  id: string;
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  isSet: boolean;
  disabled: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const [show, setShow] = useState(false);
  const cleared = value === null;
  if (cleared) {
    return (
      <div className="flex h-8 items-center justify-between gap-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 pr-1 pl-2.5 text-sm" data-secret-state="cleared">
        <span className="truncate text-destructive">Will be removed when you save</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)} disabled={disabled}>
          <RotateCcwIcon aria-hidden="true" />
          Undo
        </Button>
      </div>
    );
  }
  const text = typeof value === 'string' ? value : '';
  const multiline = f.kind === 'textarea';
  return (
    <div className="flex items-start gap-2" data-secret-state={isSet ? 'set' : 'empty'}>
      <div className="relative min-w-0 flex-1">
        {multiline ? (
          <Textarea
            id={id}
            disabled={disabled}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            maxLength={f.maxLength}
            placeholder={isSet ? '•••• set — leave empty to keep' : f.placeholder}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono text-[13px] md:text-[13px]"
            {...aria}
          />
        ) : (
          <>
            <Input
              id={id}
              disabled={disabled}
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={f.maxLength}
              placeholder={isSet ? '•••• set — leave empty to keep' : f.placeholder}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              className="pr-9"
              {...aria}
            />
            <button
              type="button"
              className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              aria-label={show ? 'Hide value' : 'Show value'}
              aria-pressed={show}
              disabled={disabled || text === ''}
              onClick={() => setShow((s) => !s)}
            >
              {show ? <EyeOffIcon className="size-3.5" aria-hidden="true" /> : <EyeIcon className="size-3.5" aria-hidden="true" />}
            </button>
          </>
        )}
      </div>
      {isSet ? (
        <Button type="button" variant="outline" onClick={() => onChange(null)} disabled={disabled} aria-label={`Clear stored ${f.label}`}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

/* ---------------- key/value ---------------- */

function asRows(v: unknown): KeyValueRow[] {
  return Array.isArray(v) ? v.filter((r): r is KeyValueRow => typeof r === 'object' && r !== null) : [];
}

function KeyValueEditor({
  id,
  field: f,
  value,
  onChange,
  isSet,
  disabled,
  invalid,
}: {
  id: string;
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  isSet: boolean;
  disabled: boolean;
  invalid: boolean;
}) {
  const secret = isSecretField(f);
  if (secret && value === null) {
    return (
      <div className="flex h-8 items-center justify-between gap-2 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 pr-1 pl-2.5 text-sm" data-secret-state="cleared">
        <span className="truncate text-destructive">All entries will be removed when you save</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)} disabled={disabled}>
          <RotateCcwIcon aria-hidden="true" />
          Undo
        </Button>
      </div>
    );
  }
  if (secret && isSet && !Array.isArray(value)) {
    return (
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 py-1 pr-1 pl-2.5 text-sm" data-secret-state="set">
        <span className="text-muted-foreground">•••• set — leave unchanged to keep</span>
        <span className="flex gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([{ key: '', value: '' }])} disabled={disabled}>
            Replace
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)} disabled={disabled} aria-label={`Clear stored ${f.label}`}>
            Clear
          </Button>
        </span>
      </div>
    );
  }
  const rows = asRows(value);
  const update = (i: number, patch: Partial<KeyValueRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-label`}>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
              <Input
                aria-label={`Name ${i + 1}`}
                placeholder="Name"
                value={r.key}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid && r.key.trim() === '' ? true : undefined}
                onChange={(e) => update(i, { key: e.target.value })}
              />
              <Input
                aria-label={`Value ${i + 1}`}
                placeholder="Value"
                type={secret ? 'password' : 'text'}
                autoComplete={secret ? 'new-password' : 'off'}
                spellCheck={false}
                value={r.value}
                disabled={disabled}
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove entry ${i + 1}`}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <PlusIcon aria-hidden="true" />
          Add entry
        </Button>
        {secret && isSet ? (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(undefined)}>
            Keep stored entries
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- status codes ---------------- */

const STATUS_PRESETS = ['200-299', '300-399', '400-499', '500-599'];

function StatusCodesEditor({
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const list = Array.isArray(value) ? value.map(String) : [];
  const add = (code: string) => {
    const c = code.trim().replace(/\s+/g, '');
    if (!c) return;
    if (!isStatusCodeRange(c)) {
      setDraftError('Use a code (301) or a range (200-299).');
      return;
    }
    setDraftError(null);
    if (!list.includes(c)) onChange([...list, c]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-label`}>
      <div className="flex min-h-8 flex-wrap items-center gap-1.5">
        {list.length === 0 ? <span className="text-xs text-muted-foreground">No accepted status codes yet.</span> : null}
        {list.map((c) => (
          <span key={c} className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 pr-0.5 pl-2 font-mono text-xs tabular-nums">
            {c}
            <button
              type="button"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              aria-label={`Remove ${c}`}
              disabled={disabled}
              onClick={() => onChange(list.filter((x) => x !== c))}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="w-36"
          placeholder="e.g. 200-299"
          inputMode="numeric"
          value={draft}
          disabled={disabled}
          aria-invalid={invalid || draftError ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button type="button" variant="outline" disabled={disabled || draft.trim() === ''} onClick={() => add(draft)}>
          Add
        </Button>
        <span className="flex flex-wrap gap-1">
          {STATUS_PRESETS.filter((p) => !list.includes(p)).map((p) => (
            <Button key={p} type="button" variant="ghost" size="sm" className="font-mono text-xs" disabled={disabled} onClick={() => add(p)}>
              +{p}
            </Button>
          ))}
        </span>
      </div>
      {draftError ? (
        <p className="text-xs text-destructive" role="alert">
          {draftError}
        </p>
      ) : null}
    </div>
  );
}
