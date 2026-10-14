// Small form building blocks shared by the monitor and maintenance editors.
import { useId, useState, type ReactNode } from 'react';
import { CheckIcon, PlusIcon, TagIcon, XIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { uptimeApi, type Tag } from '@/api/uptime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

/** Checkbox-like toggle row (button with role=checkbox). */
export function CheckRow({
  checked,
  onChange,
  children,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background dark:bg-input/30',
        )}
        aria-hidden="true"
      >
        {checked ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate">{children}</span>
        {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

/** Number input with a unit suffix ("s", "ms"). */
export function UnitInput({
  id,
  value,
  onChange,
  unit,
  min,
  max,
  step,
  invalid,
  describedBy,
  disabled,
}: {
  id: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value === undefined || Number.isNaN(value) ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className="pr-10 tabular-nums"
      />
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

/** Label + control + hint/error, with ids wired for a11y. */
export function FormField({
  label,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
  required?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </Label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
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

/* ---------------- tags ---------------- */

export const TAG_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#64748b'];

export interface TagValue {
  uid: string;
  value: string;
}

/** Selected tags (with optional values) + picker that can create tags inline. */
export function TagsEditor({
  tags,
  value,
  onChange,
  onTagCreated,
  disabled,
}: {
  tags: readonly Tag[];
  value: readonly TagValue[];
  onChange: (v: TagValue[]) => void;
  onTagCreated: (t: Tag) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byUid = new Map(tags.map((t) => [t.uid, t]));
  const q = name.trim().toLowerCase();
  const matches = tags.filter((t) => !q || t.name.toLowerCase().includes(q)).slice(0, 8);
  const exact = tags.some((t) => t.name.toLowerCase() === q);

  const add = (uid: string) => {
    onChange([...value, { uid, value: '' }]);
    setOpen(false);
    setName('');
  };
  const create = async () => {
    const n = name.trim();
    if (!n || n.length > 50) {
      setError('Use 1–50 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await uptimeApi.createTag({ name: n, color });
      onTagCreated(t);
      add(t.uid);
    } catch (err) {
      setError(errorMessage(err) || 'Could not create the tag.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {value.map((tv, i) => {
            const t = byUid.get(tv.uid);
            return (
              <li key={`${tv.uid}-${i}`} className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 text-sm">
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: t?.color ?? '#64748b' }} aria-hidden="true" />
                  <span className="bidi-isolate truncate">{t ? displayText(t.name) : 'Unknown tag'}</span>
                </span>
                <Input
                  aria-label={`Value for tag ${t ? displayText(t.name) : ''}`}
                  placeholder="Value (optional)"
                  value={tv.value}
                  maxLength={50}
                  disabled={disabled}
                  className="min-w-0 flex-1"
                  onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove tag" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" className="self-start" disabled={disabled} />}>
          <TagIcon aria-hidden="true" />
          Add tag
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <PopoverHeader>
            <PopoverTitle>Add tag</PopoverTitle>
          </PopoverHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              placeholder="Search or create…"
              value={name}
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
              aria-label="Tag name"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const first = matches[0];
                  if (exact && first) add(first.uid);
                  else if (q) void create();
                }
              }}
            />
            {matches.length > 0 ? (
              <ul className="-mx-1 flex max-h-48 flex-col overflow-y-auto">
                {matches.map((t) => (
                  <li key={t.uid}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                      onClick={() => add(t.uid)}
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: t.color }} aria-hidden="true" />
                      <span className="bidi-isolate truncate">{displayText(t.name)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {q && !exact ? (
              <div className="flex flex-col gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">New tag colour</span>
                <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag colour">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={color === c}
                      aria-label={c}
                      className={cn('size-6 rounded-full ring-offset-2 ring-offset-popover outline-none focus-visible:ring-3 focus-visible:ring-ring/50', color === c && 'ring-2 ring-foreground')}
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
                <Button type="button" onClick={() => void create()} disabled={busy}>
                  <PlusIcon aria-hidden="true" />
                  <span className="bidi-isolate truncate">Create “{displayText(name.trim())}”</span>
                </Button>
              </div>
            ) : null}
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
