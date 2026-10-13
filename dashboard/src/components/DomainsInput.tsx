import { useId, useState, type KeyboardEvent } from 'react';
import { displayText, normalizeDomain } from '../lib/safety';
import { CloseIcon } from './Icons';

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
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        Domains
      </label>
      <div className={`chips-input${disabled ? ' is-disabled' : ''}`}>
        {value.map((d) => (
          <span key={d} className="chip">
            <bdi className="bidi-isolate">{displayText(d)}</bdi>
            {!disabled ? (
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${displayText(d)}`}
                onClick={() => onChange(value.filter((x) => x !== d))}
              >
                <CloseIcon size={12} />
              </button>
            ) : null}
          </span>
        ))}
        {!disabled ? (
          <input
            id={inputId}
            className="chips-input-field"
            value={draft}
            placeholder={value.length ? 'Add another…' : 'example.com'}
            aria-describedby={helpId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (draft.trim()) commit(draft);
            }}
            maxLength={260}
          />
        ) : null}
      </div>
      <div id={helpId} className="field-help">
        {error ? (
          <span className="form-error" role="alert">
            {error}
          </span>
        ) : (
          <span className="muted">
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
