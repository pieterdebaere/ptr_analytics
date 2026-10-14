import { useId, useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '@/api/client';
import { SLUG_MAX, slugError, slugify, statusApi, type StatusPage } from '@/api/status';
import type { Site } from '@/api/types';
import { FormMessage } from '@/components/AuthCard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { displayText } from '@/lib/safety';

/** Origin shown in public links: PUBLIC_URL when configured, else this origin. */
export function publicOrigin(publicUrl: string | null | undefined): string {
  if (publicUrl && /^https?:\/\/[^/\s]+/i.test(publicUrl)) {
    try {
      return new URL(publicUrl).origin;
    } catch {
      /* fall through */
    }
  }
  return window.location.origin;
}

export function CreateStatusPageDialog({
  sites,
  defaultSiteId,
  origin,
  onClose,
  onCreated,
}: {
  sites: readonly Site[];
  defaultSiteId: string | null;
  origin: string;
  onClose: () => void;
  onCreated: (p: StatusPage) => void;
}) {
  const [siteId, setSiteId] = useState<string>(defaultSiteId ?? sites[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugServerError, setSlugServerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const slugId = useId();
  const slugHint = useId();

  const site = sites.find((s) => s.id === siteId);
  const liveSlugError = slug ? slugError(slug) : null;
  const shownSlugError = slugServerError ?? (slugTouched || slug ? liveSlugError : null);

  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugTouched) {
      setSlug(slugify(v));
      setSlugServerError(null);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSlugTouched(true);
    if (!siteId) return setError('Choose a site.');
    if (!title.trim()) return setError('Enter a title.');
    const se = slugError(slug);
    if (se) return;
    setBusy(true);
    setError(null);
    try {
      const page = await statusApi.create(siteId, { title: title.trim(), slug });
      onCreated(page);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code !== 'limit_reached') setSlugServerError('This slug is already taken.');
      else if (err instanceof ApiError && err.code === 'limit_reached') setError('This site already has the maximum number of status pages for your plan.');
      else if (err instanceof ApiError && /slug/i.test(err.message)) setSlugServerError(err.message);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New status page</DialogTitle>
            <DialogDescription>A public page that shows the health of a site&apos;s monitors. You can publish it when it&apos;s ready.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>Site</Label>
            <Select value={siteId} onValueChange={(v) => setSiteId(String(v))}>
              <SelectTrigger className="w-full" aria-label="Site">
                <SelectValue>{() => (site ? <span className="bidi-isolate truncate">{displayText(site.name)}</span> : 'Choose a site')}</SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {sites.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="bidi-isolate truncate">{displayText(s.name)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={titleId}>Title</Label>
            <Input id={titleId} value={title} maxLength={100} placeholder="Acme status" onChange={(e) => onTitle(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={slugId}>Address</Label>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText className="max-w-40 truncate sm:max-w-none">/status/</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={slugId}
                value={slug}
                maxLength={SLUG_MAX}
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={shownSlugError ? true : undefined}
                aria-describedby={slugHint}
                placeholder="acme"
                onChange={(e) => {
                  setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'));
                  setSlugTouched(true);
                  setSlugServerError(null);
                }}
              />
            </InputGroup>
            <p id={slugHint} className={shownSlugError ? 'text-xs text-destructive' : 'truncate text-xs text-muted-foreground'} data-slot="slug-hint">
              {shownSlugError ?? (slug ? `${origin}/status/${slug}` : 'Lower-case letters, digits and hyphens.')}
            </p>
          </div>
          {error ? <FormMessage>{error}</FormMessage> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !!liveSlugError || !slug || !title.trim() || !siteId}>
              {busy ? 'Creating…' : 'Create page'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
