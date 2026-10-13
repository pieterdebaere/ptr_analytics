import { useId, useState, type KeyboardEvent } from 'react';
import { XIcon } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { displayText, normalizeDomain } from '@/lib/safety';
import { cn } from '@/lib/utils';

export const MAX_DOMAINS = 20;

/** Chips input for site domains (hostname, localhost or *.example.com). */
export function DomainsInput({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (domains: string[]) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const helpId = useId();

  const commit = (raw: string): boolean => {
    const parts = raw.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0) return true;
    const next = [...value];
    for (const part of parts) {
      const d = normalizeDomain(part);
      if (!d) {
        setError(`"${part.slice(0, 100)}" is not a valid domain.`);
        return false;
      }
      if (!next.includes(d)) {
        if (next.length >= MAX_DOMAINS) {
          setError(`A site can have at most ${MAX_DOMAINS} domains.`);
          return false;
        }
        next.push(d);
      }
    }
    setError(null);
    onChange(next);
    setDraft('');
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      } else if (e.key !== 'Enter') {
        e.preventDefault();
      }
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>Domains</Label>
      <div
        className={cn(
          'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30',
          disabled && 'cursor-not-allowed bg-input/50 opacity-70',
          error && 'border-destructive ring-3 ring-destructive/20',
        )}
      >
        {value.map((d) => (
          <span key={d} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-xs font-medium">
            <bdi className="bidi-isolate truncate">{displayText(d)}</bdi>
            {!disabled ? (
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label={`Remove ${displayText(d)}`}
                onClick={() => onChange(value.filter((x) => x !== d))}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        ))}
        {!disabled ? (
          <input
            id={inputId}
            className="h-6 min-w-32 flex-1 bg-transparent px-1.5 text-base outline-none placeholder:text-muted-foreground md:text-sm"
            value={draft}
            placeholder={value.length ? 'Add another…' : 'example.com'}
            aria-describedby={helpId}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (draft.trim()) commit(draft);
            }}
            maxLength={260}
          />
        ) : null}
      </div>
      <div id={helpId} className="text-xs">
        {error ? (
          <span className="text-destructive" role="alert">
            {error}
          </span>
        ) : (
          <span className="text-muted-foreground">
            Press Enter to add. <code>example.com</code> also matches <code>www.example.com</code>; use{' '}
            <code>*.example.com</code> for all subdomains.
          </span>
        )}
      </div>
    </div>
  );
}

/** Commits any pending text in a DomainsInput-like draft when submitting a form. */
export function hasDomains(domains: string[]): boolean {
  return domains.length > 0 && domains.length <= MAX_DOMAINS;
}
