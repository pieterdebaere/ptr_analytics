// Sections and monitors of a status page (part of the editor draft).
import { useMemo, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, LayoutListIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import type { StatusSection } from '@/api/status';
import type { Monitor } from '@/api/uptime';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/common';
import { displayStatus } from '@/components/uptime/lib';
import { StatusDot } from '@/components/uptime/status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Switch } from '@/components/ui/switch';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { DISPLAY_NAME_MAX, SECTION_NAME_MAX, move } from './draft';

export function MonitorsTab({
  sections,
  onChange,
  monitors,
  monitorsError,
  onRetry,
  error,
  readOnly,
}: {
  sections: StatusSection[];
  onChange: (s: StatusSection[]) => void;
  /** Monitors of the page's site (undefined while loading). */
  monitors: Monitor[] | undefined;
  monitorsError: string | null;
  onRetry: () => void;
  error?: string;
  readOnly: boolean;
}) {
  const [picking, setPicking] = useState<number | null>(null);
  const byUid = useMemo(() => new Map((monitors ?? []).map((m) => [m.uid, m])), [monitors]);
  const used = new Set(sections.flatMap((s) => s.monitors.map((m) => m.uid)));

  const setSection = (i: number, s: StatusSection) => onChange(sections.map((x, k) => (k === i ? s : x)));
  const addSection = () => onChange([...sections, { name: sections.length === 0 ? 'Services' : `Group ${sections.length + 1}`, monitors: [] }]);

  if (monitorsError) return <ErrorState message={monitorsError} onRetry={onRetry} />;
  if (!monitors) return <SkeletonRows rows={4} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Group the site&apos;s monitors into sections. Visitors see them in this order.</p>
        {!readOnly ? (
          <Button type="button" variant="outline" onClick={addSection}>
            <PlusIcon aria-hidden="true" />
            Add group
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {sections.length === 0 ? (
        <Card className="py-0">
          <EmptyState title="No services on this page yet" icon={<LayoutListIcon />} className="py-12">
            <p>Add a group, then pick the monitors to show in it.</p>
            {!readOnly ? (
              <Button type="button" className="mt-4" onClick={addSection}>
                <PlusIcon aria-hidden="true" />
                Add group
              </Button>
            ) : null}
          </EmptyState>
        </Card>
      ) : null}

      {sections.map((section, i) => (
        <Card key={i} className="gap-0 py-0" data-section={i}>
          <CardHeader className="flex flex-row items-center gap-2 border-b px-3 py-3 sm:px-4">
            <Input
              value={section.name}
              maxLength={SECTION_NAME_MAX}
              aria-label={`Name of group ${i + 1}`}
              placeholder="Group name"
              disabled={readOnly}
              aria-invalid={!section.name.trim() ? true : undefined}
              className="max-w-sm min-w-0 flex-1 font-medium"
              onChange={(e) => setSection(i, { ...section, name: e.target.value })}
            />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Move group up" disabled={readOnly || i === 0} onClick={() => onChange(move(sections, i, -1))}>
                <ArrowUpIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move group down"
                disabled={readOnly || i === sections.length - 1}
                onClick={() => onChange(move(sections, i, 1))}
              >
                <ArrowDownIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete group ${section.name || i + 1}`}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={readOnly}
                onClick={() => onChange(sections.filter((_, k) => k !== i))}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            {section.monitors.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No monitors in this group.</p>
            ) : (
              <ul className="divide-y">
                {section.monitors.map((sm, j) => {
                  const m = byUid.get(sm.uid);
                  const setMonitor = (patch: Partial<typeof sm>) =>
                    setSection(i, { ...section, monitors: section.monitors.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
                  return (
                    <li key={sm.uid} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3 sm:px-4" data-monitor={sm.uid}>
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <StatusDot status={m ? displayStatus(m) : 'unknown'} pulse={false} />
                        <div className="flex min-w-0 flex-col">
                          <span className="bidi-isolate truncate text-sm font-medium">{m ? displayText(m.name) : 'Deleted monitor'}</span>
                          <span className="truncate text-xs text-muted-foreground">{m ? `${m.type}${m.target ? ` · ${displayText(m.target)}` : ''}` : sm.uid}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                        <Input
                          value={sm.displayName ?? ''}
                          maxLength={DISPLAY_NAME_MAX}
                          placeholder={m ? displayText(m.name) : 'Display name'}
                          aria-label="Public display name"
                          title="Public display name (leave empty to use the monitor name)"
                          disabled={readOnly}
                          className="min-w-0 basis-full sm:w-48 sm:basis-auto"
                          onChange={(e) => setMonitor({ displayName: e.target.value || null })}
                        />
                        <label className="flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs whitespace-nowrap" title="Link the name to the monitored URL (HTTP monitors)">
                          <Switch size="sm" checked={sm.showUrl} disabled={readOnly} onCheckedChange={(v) => setMonitor({ showUrl: v })} />
                          Show URL
                        </label>
                        <div className="ml-auto flex items-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Move up"
                            disabled={readOnly || j === 0}
                            onClick={() => setSection(i, { ...section, monitors: move(section.monitors, j, -1) })}
                          >
                            <ArrowUpIcon aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Move down"
                            disabled={readOnly || j === section.monitors.length - 1}
                            onClick={() => setSection(i, { ...section, monitors: move(section.monitors, j, 1) })}
                          >
                            <ArrowDownIcon aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label="Remove from page"
                            disabled={readOnly}
                            onClick={() => setSection(i, { ...section, monitors: section.monitors.filter((_, k) => k !== j) })}
                          >
                            <XIcon aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {!readOnly ? (
              <div className="border-t px-3 py-2.5 sm:px-4">
                <Button type="button" variant="ghost" onClick={() => setPicking(i)} disabled={monitors.length === 0}>
                  <PlusIcon aria-hidden="true" />
                  Add monitors
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}

      {picking !== null && sections[picking] ? (
        <MonitorPicker
          monitors={monitors.filter((m) => !used.has(m.uid))}
          sectionName={sections[picking]!.name}
          onClose={() => setPicking(null)}
          onAdd={(uids) => {
            const s = sections[picking]!;
            setSection(picking, { ...s, monitors: [...s.monitors, ...uids.map((uid) => ({ uid, displayName: null, showUrl: false }))] });
            setPicking(null);
          }}
        />
      ) : null}
    </div>
  );
}

function MonitorPicker({ monitors, sectionName, onClose, onAdd }: { monitors: Monitor[]; sectionName: string; onClose: () => void; onAdd: (uids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const query = q.trim().toLowerCase();
  const list = monitors.filter((m) => !query || m.name.toLowerCase().includes(query) || (m.target ?? '').toLowerCase().includes(query));
  const toggle = (uid: string) => setSelected((s) => (s.includes(uid) ? s.filter((x) => x !== uid) : [...s, uid]));

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add monitors</DialogTitle>
          <DialogDescription>
            To <span className="bidi-isolate font-medium text-foreground">{displayText(sectionName) || 'this group'}</span>. Only monitors of this site that are not on
            the page yet are listed.
          </DialogDescription>
        </DialogHeader>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search monitors" aria-label="Search monitors" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </InputGroup>
        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
          {monitors.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">All monitors of this site are already on the page.</p>
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No monitor matches.</p>
          ) : (
            <ul className="flex flex-col gap-1" role="listbox" aria-multiselectable="true" aria-label="Monitors">
              {list.map((m) => {
                const on = selected.includes(m.uid);
                return (
                  <li key={m.uid}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={on}
                      onClick={() => toggle(m.uid)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50',
                        on ? 'border-primary/40 bg-primary/[0.04]' : 'border-transparent',
                      )}
                    >
                      <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input')} aria-hidden="true">
                        {on ? <CheckIcon className="size-3" /> : null}
                      </span>
                      <StatusDot status={displayStatus(m)} pulse={false} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="bidi-isolate truncate text-sm font-medium">{displayText(m.name)}</span>
                        <span className="truncate text-xs text-muted-foreground">{m.target ? displayText(m.target) : m.type}</span>
                      </span>
                      <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
                        {m.type}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={selected.length === 0} onClick={() => onAdd(selected)}>
            Add {selected.length > 0 ? selected.length : ''} {selected.length === 1 ? 'monitor' : 'monitors'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
