// Incidents of a status page: immediate CRUD (not part of the page draft).
import { useId, useState, type FormEvent } from 'react';
import { CircleCheckIcon, EllipsisIcon, MegaphoneIcon, PencilIcon, PinIcon, PinOffIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { INCIDENT_STYLES, statusApi, type Incident, type IncidentStyle } from '@/api/status';
import { FormMessage } from '@/components/AuthCard';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/common';
import { INCIDENT_STYLE_META, IncidentCallout, incidentMeta } from '@/components/status/incidents';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { MARKDOWN_MAX, TITLE_MAX } from './draft';
import { MarkdownField } from './MarkdownField';

export function IncidentsTab({ pageUid, readOnly }: { pageUid: string; readOnly: boolean }) {
  const { data, error, loading, reload } = useApi((signal) => statusApi.incidents(pageUid, signal), [pageUid]);
  const [editing, setEditing] = useState<Incident | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Incident | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = [...(data ?? [])].sort((a, b) => {
    const ra = a.resolvedAt === null ? 0 : 1;
    const rb = b.resolvedAt === null ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  const open = list.filter((i) => i.resolvedAt === null);
  const resolved = list.filter((i) => i.resolvedAt !== null);

  const patch = async (i: Incident, body: { resolved?: boolean; pinned?: boolean }) => {
    setBusy(i.uid);
    setActionError(null);
    try {
      await statusApi.updateIncident(i.uid, body);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (i: Incident) => {
    setBusy(i.uid);
    setActionError(null);
    try {
      await statusApi.deleteIncident(i.uid);
      setDeleting(null);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
      setDeleting(null);
    } finally {
      setBusy(null);
    }
  };

  const actions = (i: Incident) =>
    readOnly ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${i.title}`} disabled={busy === i.uid} />}>
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setEditing(i)}>
            <PencilIcon aria-hidden="true" />
            Edit
          </DropdownMenuItem>
          {i.resolvedAt === null ? (
            <DropdownMenuItem onClick={() => void patch(i, { resolved: true })}>
              <CircleCheckIcon aria-hidden="true" />
              Resolve
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => void patch(i, { resolved: false })}>
              <RotateCcwIcon aria-hidden="true" />
              Reopen
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void patch(i, { pinned: !i.pinned })}>
            {i.pinned ? <PinOffIcon aria-hidden="true" /> : <PinIcon aria-hidden="true" />}
            {i.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(i)}>
            <Trash2Icon aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Open incidents are shown at the top of the page; resolved ones move to the history.</p>
        {!readOnly ? (
          <Button type="button" onClick={() => setEditing('new')}>
            <PlusIcon aria-hidden="true" />
            Post incident
          </Button>
        ) : null}
      </div>
      {actionError ? <FormMessage>{actionError}</FormMessage> : null}
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <SkeletonRows rows={3} />
      ) : list.length === 0 ? (
        <Card className="py-0">
          <EmptyState title="No incidents" icon={<MegaphoneIcon />} className="py-12">
            Post an incident to tell visitors about an outage, degraded performance or planned work.
          </EmptyState>
        </Card>
      ) : (
        <>
          {open.length > 0 ? (
            <section className="flex flex-col gap-3" aria-label="Open incidents">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Open</h3>
              {open.map((i) => (
                <IncidentCallout
                  key={i.uid}
                  style={i.style}
                  title={i.title}
                  body={i.body}
                  meta={
                    <span className="flex flex-wrap items-center gap-2">
                      {incidentMeta(i)}
                      {i.pinned ? (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          <PinIcon aria-hidden="true" />
                          Pinned
                        </Badge>
                      ) : null}
                    </span>
                  }
                  actions={actions(i)}
                />
              ))}
            </section>
          ) : null}
          {resolved.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Resolved incidents">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Resolved</h3>
              <Card className="gap-0 py-0">
                <ul className="divide-y">
                  {resolved.map((i) => (
                    <li key={i.uid} className="flex items-start gap-3 px-4 py-3">
                      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', INCIDENT_STYLE_META[i.style].dot)} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="bidi-isolate truncate text-sm font-medium">{displayText(i.title) || 'Untitled'}</p>
                        <p className="text-xs text-muted-foreground">{incidentMeta(i)}</p>
                      </div>
                      {actions(i)}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ) : null}
        </>
      )}

      {editing ? (
        <IncidentDialog
          pageUid={pageUid}
          incident={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => (o ? undefined : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete incident</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong className="bidi-isolate break-all text-foreground">{deleting ? displayText(deleting.title) : ''}</strong>? It disappears from the page and the
              history. To keep it in the history, resolve it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={!deleting || busy === deleting.uid} onClick={() => deleting && void remove(deleting)}>
              Delete incident
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IncidentDialog({ pageUid, incident, onClose, onSaved }: { pageUid: string; incident: Incident | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(incident?.title ?? '');
  const [body, setBody] = useState(incident?.body ?? '');
  const [style, setStyle] = useState<IncidentStyle>(incident?.style ?? 'warning');
  const [pinned, setPinned] = useState(incident?.pinned ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError('Enter a title.');
    if (body.length > MARKDOWN_MAX) return setError(`The text can have at most ${MARKDOWN_MAX} characters.`);
    setBusy(true);
    setError(null);
    try {
      const input = { title: title.trim(), body, style, pinned };
      if (incident) await statusApi.updateIncident(incident.uid, input);
      else await statusApi.createIncident(pageUid, input);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{incident ? 'Edit incident' : 'Post incident'}</DialogTitle>
            <DialogDescription>Visible to everyone who opens the status page.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input id={titleId} value={title} maxLength={TITLE_MAX} placeholder="Elevated error rates on the API" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Style</legend>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Style">
              {INCIDENT_STYLES.map((s) => {
                const meta = INCIDENT_STYLE_META[s];
                const I = meta.icon;
                return (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={style === s}
                    onClick={() => setStyle(s)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                      style === s && cn(meta.box, 'ring-1 ring-foreground/15'),
                    )}
                  >
                    <I className={cn('size-4', meta.icon_)} aria-hidden="true" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <MarkdownField label="Details" value={body} onChange={setBody} maxLength={MARKDOWN_MAX} rows={5} placeholder="We are investigating increased error rates. Next update in 30 minutes." />
          <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3">
            <span className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">Pinned</span>
              <span className="text-xs text-muted-foreground">Keep it at the top of the page while it is open.</span>
            </span>
            <Switch checked={pinned} onCheckedChange={setPinned} />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Preview</span>
            <IncidentCallout style={style} title={title || 'Incident title'} body={body} />
          </div>
          {error ? <FormMessage>{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : incident ? 'Save changes' : 'Post incident'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
