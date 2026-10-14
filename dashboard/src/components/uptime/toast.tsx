// Minimal toast notices for the uptime screens (action feedback). Plain text only.
import { useEffect, useState } from 'react';
import { CheckCircle2Icon, AlertCircleIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

function emit() {
  for (const l of listeners) l(toasts);
}

export function toast(text: string, tone: Tone = 'success'): void {
  const t = { id: nextId++, text: text.slice(0, 300), tone };
  toasts = [...toasts.slice(-3), t];
  emit();
  window.setTimeout(() => dismiss(t.id), tone === 'error' ? 7000 : 4000);
}

function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function Toaster() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:right-4 sm:left-auto sm:items-end" aria-live="polite" role="status">
      {list.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 animate-in fade-in-0 slide-in-from-bottom-2',
          )}
        >
          {t.tone === 'error' ? (
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className={cn('mt-0.5 size-4 shrink-0', t.tone === 'success' ? 'text-good' : 'text-muted-foreground')} aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button
            type="button"
            className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
