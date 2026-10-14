// Custom domains of a status page (saved immediately) with TXT verification.
import { useId, useState, type FormEvent } from 'react';
import { CircleCheckIcon, ClockIcon, GlobeIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { statusApi, type StatusDomain, type StatusPage } from '@/api/status';
import { FormMessage } from '@/components/AuthCard';
import { CopyButton, EmptyState } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDateLong } from '@/components/uptime/lib';
import { displayText, normalizeDomain } from '@/lib/safety';

const DAY = 86_400_000;

/** "Expires in 6 days" for an unverified claim (dropped 7 days after it was added). */
export function claimExpiry(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expired — add it again';
  if (ms < DAY) return 'Expires today';
  const days = Math.ceil(ms / DAY);
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Hostname for a custom status domain, or null (no wildcards, localhost or IP literals). */
export function normalizeStatusDomain(input: string): string | null {
  const d = normalizeDomain(input);
  if (!d || d === 'localhost' || d.startsWith('*.') || /^[\d.]+$/.test(d)) return null;
  return d;
}

function RecordRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs select-all" title={value}>
        {value}
      </code>
      <CopyButton text={value} className="justify-self-start" />
    </div>
  );
}

export function DomainsTab({ page, onPageChange, publicHost, readOnly }: { page: StatusPage; onPageChange: (p: StatusPage) => void; publicHost: string; readOnly: boolean }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const inputId = useId();

  const save = async (domains: string[], key: string) => {
    setBusy(key);
    setError(null);
    try {
      onPageChange(await statusApi.update(page.uid, { domains }));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const d = normalizeStatusDomain(input);
    if (!d) return setError('Enter a domain name such as status.example.com.');
    if (page.domains.some((x) => x.domain === d)) return setError('This domain is already on the list.');
    if (await save([...page.domains.map((x) => x.domain), d], 'add')) setInput('');
  };

  const verify = async (d: StatusDomain) => {
    setBusy(d.domain);
    setError(null);
    try {
      const r = await statusApi.verifyDomain(page.uid, d.domain);
      onPageChange({ ...page, domains: page.domains.map((x) => (x.domain === r.domain ? r : x)) });
      setNotes((n) => ({
        ...n,
        [d.domain]: r.verified
          ? ''
          : 'Not verified yet: the TXT record with this page’s value was not found. DNS changes can take a while to propagate. If another status page already verified this domain, it keeps it while its own TXT record is published.',
      }));
    } catch (e) {
      setNotes((n) => ({ ...n, [d.domain]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Custom domains</CardTitle>
          <CardDescription>
            Serve this page at your own address, e.g. <span className="font-mono">status.example.com</span>. Prove ownership with a DNS TXT record within 7 days
            (unverified domains are removed then), then point the domain at this server (your reverse proxy handles TLS).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!readOnly ? (
            <form onSubmit={add} className="flex flex-col gap-2" noValidate>
              <Label htmlFor={inputId}>Add domain</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id={inputId}
                  value={input}
                  maxLength={253}
                  placeholder="status.example.com"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="sm:max-w-sm"
                  onChange={(e) => {
                    setInput(e.target.value);
                    setError(null);
                  }}
                />
                <Button type="submit" variant="outline" disabled={busy === 'add' || !input.trim()}>
                  <PlusIcon aria-hidden="true" />
                  Add
                </Button>
              </div>
              {error ? <FormMessage>{error}</FormMessage> : null}
            </form>
          ) : null}
        </CardContent>
      </Card>

      {page.domains.length === 0 ? (
        <Card className="py-0">
          <EmptyState title="No custom domains" icon={<GlobeIcon />} className="py-10">
            The page is available at <span className="font-mono">/status/{displayText(page.slug)}</span> on this server.
          </EmptyState>
        </Card>
      ) : (
        page.domains.map((d) => (
          <Card key={d.domain} className="gap-4" data-domain={d.domain}>
            <CardHeader className="flex flex-row flex-wrap items-center gap-2">
              <CardTitle className="min-w-0 truncate font-mono text-[0.95rem]">{displayText(d.domain)}</CardTitle>
              {d.verified ? (
                <Badge className="bg-good/12 text-good-text">
                  <CircleCheckIcon aria-hidden="true" />
                  Verified
                </Badge>
              ) : (
                <Badge className="bg-warn/15 text-warn-text">
                  <ClockIcon aria-hidden="true" />
                  Pending verification
                </Badge>
              )}
              {!d.verified && d.expiresAt !== null ? (
                <span className="text-xs text-muted-foreground" title={`Unverified domains are removed on ${formatDateLong(d.expiresAt)}`} data-slot="domain-expiry">
                  {claimExpiry(d.expiresAt)}
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                {!d.verified && !readOnly ? (
                  <Button type="button" variant="outline" disabled={busy === d.domain} onClick={() => void verify(d)}>
                    <RefreshCwIcon className={busy === d.domain ? 'animate-spin' : undefined} aria-hidden="true" />
                    Check now
                  </Button>
                ) : null}
                {!readOnly ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${d.domain}`}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy !== null}
                    onClick={() => void save(page.domains.filter((x) => x.domain !== d.domain).map((x) => x.domain), d.domain)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              {!d.verified ? (
                <div className="flex flex-col gap-2">
                  <p className="font-medium">1. Add this TXT record at your DNS provider</p>
                  <RecordRow label="Type" value="TXT" />
                  <RecordRow label="Name" value={d.txtName} />
                  <RecordRow label="Value" value={d.verifyToken} />
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <p className="font-medium">{d.verified ? 'DNS' : '2. Point the domain to this server'}</p>
                <RecordRow label="CNAME" value={`${d.domain} → ${publicHost}`} />
              </div>
              {notes[d.domain] ? <p className="text-xs text-muted-foreground">{displayText(notes[d.domain]!)}</p> : null}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
