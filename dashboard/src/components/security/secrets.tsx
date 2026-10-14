// Display helpers for one-time secrets (recovery codes, API keys). Values are only kept
// in component state, copied to the clipboard or downloaded on request — never logged.
import { useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { CopyButton } from '@/components/common';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Saves `text` as a .txt file through a short-lived Blob URL. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "JBSWY3DPEHPK3PXP" → "JBSW Y3DP EHPK 3PXP" */
export function groupSecret(secret: string, size = 4): string {
  return secret.replace(new RegExp(`(.{${size}})(?=.)`, 'g'), '$1 ');
}

export function recoveryCodesText(codes: readonly string[], account: string, origin: string): string {
  return [
    'PTR Analytics — two-factor recovery codes',
    `Account: ${account}`,
    `Site: ${origin}`,
    `Created: ${new Date().toISOString().slice(0, 10)}`,
    '',
    'Each code can be used once instead of an authenticator code.',
    'Keep them somewhere safe (e.g. a password manager).',
    '',
    ...codes,
    '',
  ].join('\n');
}

export function RecoveryCodes({ codes, account, onSavedChange }: { codes: readonly string[]; account: string; onSavedChange?: (saved: boolean) => void }) {
  const [saved, setSaved] = useState(false);
  const mark = () => {
    if (!saved) {
      setSaved(true);
      onSavedChange?.(true);
    }
  };
  const text = recoveryCodesText(codes, account, window.location.origin);
  return (
    <div className="flex flex-col gap-3">
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-3 font-mono text-sm tabular-nums" aria-label="Recovery codes" data-slot="recovery-codes">
        {codes.map((c, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="w-4 text-right text-[11px] text-muted-foreground select-none">{i + 1}</span>
            <span className="select-all">{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2" onClickCapture={mark}>
        <CopyButton text={codes.join('\n')} label="Copy codes" />
        <Button type="button" variant="outline" size="sm" onClick={() => downloadText('ptr-analytics-recovery-codes.txt', text)}>
          <DownloadIcon aria-hidden="true" />
          Download .txt
        </Button>
      </div>
    </div>
  );
}

/** A secret shown once, in a monospace box with copy. */
export function SecretValue({ value, label, className, wrap = false }: { value: string; label: string; className?: string; wrap?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3', className)}>
      <code className={cn('min-w-0 flex-1 py-1 text-[0.8rem] select-all', wrap ? 'break-all' : 'overflow-x-auto whitespace-nowrap')} aria-label={label}>
        {value}
      </code>
      <CopyButton text={value} className="shrink-0 bg-background" />
    </div>
  );
}
