import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'fixed -left-[9999px] top-0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = 'Copy to clipboard', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? 'Copied' : label}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1600);
        }
      }}
    >
      {copied ? <Check className="text-good" /> : <Copy />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </Button>
  );
}

export interface CodeBlockProps {
  code: string;
  /** Small label in the header bar, e.g. "bash" or "index.html". */
  title?: string;
  /** Prefix each line with a muted `$` prompt (shell commands). */
  prompt?: boolean;
  className?: string;
}

/** Copyable code block. Lines starting with `#` are rendered as comments. */
export function CodeBlock({ code, title, prompt = false, className }: CodeBlockProps) {
  const lines = code.split('\n');
  const copyValue = lines.filter((l) => !(prompt && l.trimStart().startsWith('#'))).join('\n');
  return (
    <div className={cn('group/code relative overflow-hidden rounded-xl border bg-surface text-left', className)}>
      <div className="flex h-10 items-center justify-between gap-2 border-b pr-1.5 pl-4">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          {title ? <span className="ml-1.5 truncate">{title}</span> : null}
        </span>
        <CopyButton text={copyValue} label={title ? `Copy ${title}` : undefined} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6">
        <code>
          {lines.map((line, i) => {
            const isComment = line.trimStart().startsWith('#');
            return (
              <span key={i} className="block whitespace-pre">
                {prompt && !isComment && line.length > 0 ? (
                  <span className="mr-3 select-none text-muted-foreground/60" aria-hidden="true">
                    $
                  </span>
                ) : null}
                <span className={isComment ? 'text-muted-foreground' : undefined}>{line || ' '}</span>
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
