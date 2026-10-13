import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2Icon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { CodeBlock } from '@/components/common';
import { DomainsInput, MAX_DOMAINS, MEMBER_MAX_DOMAINS } from '@/components/DomainsInput';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth, useCanManageSites } from '@/hooks/auth';
import {
  DECLARATIVE_EXAMPLE,
  IGNORE_SNIPPET,
  QUEUE_SNIPPET,
  QUEUE_TRACK_EXAMPLE,
  TRACK_EXAMPLE,
  installSnippet,
  snippetOrigin,
} from '@/lib/snippet';
import { displayText } from '@/lib/safety';
import { useSite } from './SiteLayout';

function InlineCode({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-[0.8em]">{children}</code>;
}

export function SiteSettingsPage() {
  const { site, reloadSites } = useSite();
  const { config } = useAuth();
  const canManage = useCanManageSites();
  const origin = snippetOrigin(config?.publicUrl, window.location.origin);

  return (
    <div className="flex flex-col gap-4">
      <GeneralSettings key={site.id} readOnly={!canManage} onSaved={reloadSites} />

      <Card>
        <CardHeader>
          <CardTitle>Install</CardTitle>
          <CardDescription>
            Add this line to the <InlineCode>&lt;head&gt;</InlineCode> of every page you want to track.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeBlock code={installSnippet(origin, site.id)} />
          <p className="text-xs text-muted-foreground">
            Site ID: <InlineCode>{site.id}</InlineCode>. Page views (including single-page-app navigations) and Speed Insights
            are collected automatically. Visits are only accepted from the domains listed above.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom events</CardTitle>
          <CardDescription>Track conversions and other interactions from JavaScript.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <CodeBlock code={TRACK_EXAMPLE} />
          <p>
            To call <InlineCode>pa</InlineCode> before the script has loaded, add this queue snippet above the script tag —
            queued calls are sent once it loads:
          </p>
          <CodeBlock code={QUEUE_SNIPPET} />
          <CodeBlock code={QUEUE_TRACK_EXAMPLE} />
          <p>
            Or track clicks without JavaScript using data attributes (<InlineCode>data-pa-event-*</InlineCode> attributes
            become properties):
          </p>
          <CodeBlock code={DECLARATIVE_EXAMPLE} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exclude your own visits</CardTitle>
          <CardDescription>
            Open your website, open the browser console (developer tools) and run the following. The script then ignores
            visits from this browser on that site.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeBlock code={IGNORE_SNIPPET} />
          <p className="text-xs text-muted-foreground">
            Use <InlineCode>localStorage.removeItem('pa_ignore')</InlineCode> to be counted again.
          </p>
        </CardContent>
      </Card>

      {canManage ? <DangerZone /> : null}
    </div>
  );
}

function GeneralSettings({ readOnly, onSaved }: { readOnly: boolean; onSaved: () => void }) {
  const { site } = useSite();
  const [name, setName] = useState(site.name);
  const [domains, setDomains] = useState<string[]>(site.domains);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const nameId = useId();
  const { user } = useAuth();
  const maxDomains = user?.role === 'member' ? MEMBER_MAX_DOMAINS : MAX_DOMAINS;

  useEffect(() => {
    setName(site.name);
    setDomains(site.domains);
  }, [site.name, site.domains]);

  const dirty = name.trim() !== site.name || domains.join('\n') !== site.domains.join('\n');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setMessage({ kind: 'error', text: 'Enter a name.' });
    if (domains.length === 0) return setMessage({ kind: 'error', text: 'Add at least one domain.' });
    setBusy(true);
    setMessage(null);
    try {
      await api.updateSite(site.id, { name: name.trim(), domains });
      setMessage({ kind: 'ok', text: 'Saved.' });
      onSaved();
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>{readOnly ? 'Only admins and the site owner can change these settings.' : 'Name and domains of this site.'}</CardDescription>
        </CardHeader>
        <CardContent className="flex max-w-xl flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input id={nameId} value={name} maxLength={100} required readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
          </div>
          <DomainsInput value={domains} onChange={setDomains} disabled={readOnly} max={maxDomains} />
          {message ? (
            <p className={message.kind === 'ok' ? 'text-sm text-good' : 'text-sm text-destructive'} role="status">
              {message.text}
            </p>
          ) : null}
        </CardContent>
        {readOnly ? null : (
          <CardFooter className="justify-end">
            <Button type="submit" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

function DangerZone() {
  const { site, reloadSites } = useSite();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  // Accept the name as displayed (control/bidi characters replaced) or the raw name.
  const confirmed = confirm === site.name || confirm === displayText(site.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmId = useId();

  const close = () => {
    setOpen(false);
    setConfirm('');
    setError(null);
  };

  const onDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSite(site.id);
      reloadSites();
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">Delete this site</div>
          <p className="text-sm text-muted-foreground">Permanently deletes the site and all its analytics and Speed Insights data.</p>
        </div>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)} className="self-start sm:self-auto">
          <Trash2Icon aria-hidden="true" />
          Delete site
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={onDelete} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Delete site</DialogTitle>
              <DialogDescription>
                This deletes <strong className="bidi-isolate break-all text-foreground">{displayText(site.name)}</strong> and all of
                its data. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={confirmId} className="block leading-snug">
                Type <strong className="bidi-isolate break-all">{displayText(site.name)}</strong> to confirm
              </Label>
              <Input id={confirmId} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
                {busy ? 'Deleting…' : 'Delete permanently'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
