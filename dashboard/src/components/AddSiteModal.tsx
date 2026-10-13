import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightIcon, CheckCircle2Icon, SparklesIcon } from 'lucide-react';
import { api, errorMessage, isUpgradeRequired } from '@/api/client';
import type { Site } from '@/api/types';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/auth';
import { formatPrice, pricingNote } from '@/lib/billing';
import { displayText } from '@/lib/safety';
import { installSnippet, snippetOrigin } from '@/lib/snippet';
import { CodeBlock } from './common';
import { DomainsInput, MAX_DOMAINS, MEMBER_MAX_DOMAINS } from './DomainsInput';

/** Shown when POST /api/sites answers 402 upgrade_required. */
export function UpgradeContent({ onClose }: { onClose: () => void }) {
  const { publicConfig } = useAuth();
  const billing = publicConfig.billingEnabled;
  return (
    <>
      <DialogHeader>
        <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-chart-1/12 text-chart-1">
          <SparklesIcon className="size-5" aria-hidden="true" />
        </div>
        <DialogTitle>{billing ? 'Upgrade to add more sites' : 'Site limit reached'}</DialogTitle>
        <DialogDescription>
          {billing
            ? `${pricingNote(publicConfig)}. Add paid sites in Billing — you can change the number at any time.`
            : 'Your account reached the maximum number of sites. Delete a site you no longer need to add a new one.'}
        </DialogDescription>
      </DialogHeader>
      {billing ? (
        <div className="flex items-baseline justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
          <span className="text-sm text-muted-foreground">Each additional site</span>
          <span className="text-sm font-semibold tabular-nums">
            {formatPrice(publicConfig.pricePerSiteCents, publicConfig.currency)}
            <span className="font-normal text-muted-foreground"> / month</span>
          </span>
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {billing ? 'Not now' : 'Close'}
        </Button>
        {billing ? (
          <Link to="/billing" className={buttonVariants()} onClick={onClose}>
            Go to billing
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </Link>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function AddSiteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (site: Site) => void }) {
  const { config, user } = useAuth();
  const maxDomains = user?.role === 'member' ? MEMBER_MAX_DOMAINS : MAX_DOMAINS;
  const [name, setName] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Site | null>(null);
  const [upgrade, setUpgrade] = useState(false);
  const nameId = useId();

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Enter a name.');
    if (domains.length === 0) return setError('Add at least one domain.');
    setBusy(true);
    setError(null);
    try {
      const site = await api.createSite({ name: name.trim(), domains });
      setCreated(site);
      onCreated(site);
    } catch (err) {
      if (isUpgradeRequired(err)) setUpgrade(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        {upgrade ? (
          <UpgradeContent onClose={onClose} />
        ) : created ? (
          <>
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-good/12 text-good">
                <CheckCircle2Icon className="size-5" aria-hidden="true" />
              </div>
              <DialogTitle>Site added</DialogTitle>
              <DialogDescription>
                Add this snippet to the <code>&lt;head&gt;</code> of every page of{' '}
                <strong className="bidi-isolate text-foreground">{displayText(created.name)}</strong>. Data appears within seconds
                after the first visit.
              </DialogDescription>
            </DialogHeader>
            <CodeBlock code={installSnippet(snippetOrigin(config?.publicUrl, window.location.origin), created.id)} />
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
              <Link to={`/sites/${encodeURIComponent(created.id)}`} className={buttonVariants()} onClick={onClose}>
                Open dashboard
              </Link>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Add site</DialogTitle>
              <DialogDescription>Give it a name and the domains it is served from.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={100}
                required
                autoFocus
                placeholder="My website"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <DomainsInput value={domains} onChange={setDomains} max={maxDomains} />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Adding…' : 'Add site'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
