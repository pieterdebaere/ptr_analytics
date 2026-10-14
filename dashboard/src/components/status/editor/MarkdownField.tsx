import { useId } from 'react';
import { SafeMarkdown, droppedLinkTargets } from '@/components/markdown/SafeMarkdown';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

export const MARKDOWN_HELP = '**bold**, *italic*, `code`, lists, ### headings and [links](https://…) or [links](/status/…)';

/** Markdown textarea with a live preview rendered by SafeMarkdown (side by side on wide screens). */
export function MarkdownField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  error,
  rows = 4,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  placeholder?: string;
  error?: string;
  rows?: number;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  const dropped = droppedLinkTargets(value);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className={cn('text-xs tabular-nums text-muted-foreground', value.length > maxLength && 'text-destructive')}>
          {value.length}/{maxLength}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          className="field-sizing-fixed min-h-28 resize-y font-mono text-[0.8rem] leading-relaxed md:text-[0.8rem]"
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="min-h-28 overflow-auto rounded-lg border border-dashed bg-muted/30 px-3 py-2" aria-label={`${label} preview`} data-slot="markdown-preview">
          {value.trim() ? (
            <SafeMarkdown source={value} className="text-sm" maxLength={maxLength} />
          ) : (
            <span className="text-xs text-muted-foreground">Preview</span>
          )}
        </div>
      </div>
      <p id={hintId} className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? hint ?? `Markdown: ${MARKDOWN_HELP}. No HTML or images.`}
      </p>
      {dropped.length > 0 ? (
        <p className="text-xs text-warn-text" role="status" data-slot="dropped-links">
          Shown as plain text, not as a link: <span className="bidi-isolate font-mono break-all">{dropped.map((t) => displayText(t.slice(0, 80))).join(', ')}</span>. Links must start
          with https://, http://, mailto: or a single /.
        </p>
      ) : null}
    </div>
  );
}
