// Small shared UI primitives.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { changeTone, formatChange } from '../lib/format';
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon, InfoIcon } from './Icons';

/* ---------------- Modal ---------------- */

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button:not(.modal-close)');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && el) {
        // simple focus trap
        const items = Array.from(
          el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
        );
        if (items.length === 0) return;
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- Segmented tabs ---------------- */

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  size = 'sm',
}: {
  items: ReadonlyArray<TabItem<K>>;
  value: K;
  onChange: (k: K) => void;
  label: string;
  size?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  // When the tabs don't fit (narrow panels / phones) they scroll horizontally; fade the
  // edge that has more tabs behind it so it is clear there is more to see.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [items.length]);

  // Keep the active tab visible.
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('.tab-active');
    if (!el || !active) return;
    if (active.offsetLeft < el.scrollLeft || active.offsetLeft + active.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: active.offsetLeft - 24, behavior: 'smooth' });
    }
  }, [value]);

  const cls = `tabs tabs-${size}${fade.left ? ' tabs-fade-left' : ''}${fade.right ? ' tabs-fade-right' : ''}`;
  return (
    <div ref={ref} className={cls} role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={it.key === value}
          className={`tab${it.key === value ? ' tab-active' : ''}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- States ---------------- */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`skeleton-row skeleton-w${(i % 4) + 1}`} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <AlertIcon />
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

/* ---------------- Change badge ---------------- */

export function ChangeBadge({ change, lowerIsBetter = false }: { change: number | null; lowerIsBetter?: boolean }) {
  const text = formatChange(change);
  if (!text) return null;
  const tone = changeTone(change, lowerIsBetter);
  return <span className={`change change-${tone}`}>{text}</span>;
}

/* ---------------- Copy / code ---------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'offscreen';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => setState((await copyText(text)) ? 'copied' : 'failed')}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}</span>
    </button>
  );
}

export function CodeBlock({ code, copy = true }: { code: string; copy?: boolean }) {
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
      {copy ? (
        <div className="code-copy">
          <CopyButton text={code} />
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Info tooltip ---------------- */

export function InfoTip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="infotip">
      <button type="button" className="infotip-btn" aria-describedby={id} aria-label="More information">
        <InfoIcon size={14} />
      </button>
      <span role="tooltip" id={id} className="infotip-text">
        {text}
      </span>
    </span>
  );
}

/* ---------------- Dropdown menu ---------------- */

export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return ref;
}
