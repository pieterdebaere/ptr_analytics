// Incident / maintenance callouts and overall-status presentation, shared by the
// public status page and the editor previews. All text is untrusted: titles via
// displayText, bodies via SafeMarkdown only.
import type { ComponentType, ReactNode } from 'react';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  InfoIcon,
  MegaphoneIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from 'lucide-react';
import type { IncidentStyle, OverallStatus } from '@/api/status';
import { SafeMarkdown } from '@/components/markdown/SafeMarkdown';
import { formatDateTime } from '@/components/uptime/lib';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;

export const INCIDENT_STYLE_META: Record<IncidentStyle, { label: string; icon: Icon; box: string; icon_: string; dot: string }> = {
  info: { label: 'Info', icon: InfoIcon, box: 'border-chart-1/30 bg-chart-1/[0.07]', icon_: 'text-maint-text', dot: 'bg-chart-1' },
  warning: { label: 'Warning', icon: TriangleAlertIcon, box: 'border-warn/40 bg-warn/[0.09]', icon_: 'text-warn-text', dot: 'bg-warn' },
  danger: { label: 'Danger', icon: OctagonAlertIcon, box: 'border-poor/35 bg-poor/[0.07]', icon_: 'text-poor-text', dot: 'bg-poor' },
  success: { label: 'Success', icon: CircleCheckIcon, box: 'border-good/35 bg-good/[0.07]', icon_: 'text-good-text', dot: 'bg-good' },
  neutral: { label: 'Neutral', icon: MegaphoneIcon, box: 'border-border bg-muted/60', icon_: 'text-muted-foreground', dot: 'bg-muted-foreground' },
};

export const OVERALL_META: Record<OverallStatus, { label: string; icon: Icon; soft: string; solid: string; text: string }> = {
  up: { label: 'All systems operational', icon: CircleCheckIcon, soft: 'border-good/30 bg-good/[0.08]', solid: 'bg-good', text: 'text-good-text' },
  degraded: { label: 'Partial outage', icon: TriangleAlertIcon, soft: 'border-warn/40 bg-warn/[0.1]', solid: 'bg-warn', text: 'text-warn-text' },
  down: { label: 'Major outage', icon: CircleAlertIcon, soft: 'border-poor/35 bg-poor/[0.08]', solid: 'bg-poor', text: 'text-poor-text' },
  maintenance: { label: 'Under maintenance', icon: WrenchIcon, soft: 'border-chart-1/30 bg-chart-1/[0.08]', solid: 'bg-chart-1', text: 'text-maint-text' },
  unknown: { label: 'Status unknown', icon: CircleHelpIcon, soft: 'border-border bg-muted/60', solid: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

/** Callout for an incident (or a maintenance notice) with a Markdown body. */
export function IncidentCallout({
  style,
  title,
  body,
  meta,
  icon,
  actions,
  linkClassName,
  className,
}: {
  style: IncidentStyle;
  title: string;
  body?: string | null;
  meta?: ReactNode;
  icon?: Icon;
  actions?: ReactNode;
  linkClassName?: string;
  className?: string;
}) {
  const s = INCIDENT_STYLE_META[style];
  const I = icon ?? s.icon;
  return (
    <article className={cn('flex gap-3 rounded-xl border p-4', s.box, className)} data-style={style}>
      <I className={cn('mt-0.5 size-5 shrink-0', s.icon_)} aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="bidi-isolate min-w-0 text-[0.95rem] leading-snug font-semibold break-words">{displayText(title) || 'Untitled'}</h3>
        {body ? <SafeMarkdown source={body} className="text-sm text-foreground/85" linkClassName={linkClassName} /> : null}
        {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
      </div>
      {/* Own column: stays top-right next to the title at any width. */}
      {actions ? <div className="-mt-1 -mr-1 flex shrink-0 items-start gap-1">{actions}</div> : null}
    </article>
  );
}

/** "Posted Oct 3, 14:05 · Updated … · Resolved …" */
export function incidentMeta(i: { createdAt: number | null; updatedAt: number | null; resolvedAt: number | null }): string {
  const parts: string[] = [];
  if (i.createdAt) parts.push(`Posted ${formatDateTime(i.createdAt)}`);
  if (i.updatedAt && i.updatedAt !== i.createdAt && !i.resolvedAt) parts.push(`Updated ${formatDateTime(i.updatedAt)}`);
  if (i.resolvedAt) parts.push(`Resolved ${formatDateTime(i.resolvedAt)}`);
  return parts.join(' · ');
}
