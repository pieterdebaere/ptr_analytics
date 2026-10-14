// API keys (bearer, scoped) for /metrics and read-only automation, docs/SPEC.md §8.3.
import { useId, useState, type FormEvent } from 'react';
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { API_KEY_SCOPES, securityApi, type ApiKey, type ApiKeyScope, type CreatedApiKey } from '@/api/security';
import { FormMessage } from '@/components/AuthCard';
import { CodeBlock, EmptyState, ErrorState, SkeletonRows } from '@/components/common';
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
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateLong, formatRelative } from '@/components/uptime/lib';
import { useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { SecretValue } from './secrets';

const SCOPE_INFO: Record<ApiKeyScope, { label: string; help: string }> = {
  read: { label: 'Read', help: 'Read-only access to the REST API (sites, statistics, monitors).' },
  metrics: { label: 'Metrics', help: 'Scrape /metrics in Prometheus format (your monitors only).' },
};

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const;

/** Prometheus scrape config for the given server origin. */
export function prometheusExample(origin: string, key: string): string {
  let scheme = 'https';
  let host = 'analytics.example.com';
  try {
    const u = new URL(origin);
    scheme = u.protocol.replace(':', '');
    host = u.host;
  } catch {
    /* keep the placeholder */
  }
  return [
    'scrape_configs:',
    '  - job_name: ptr-analytics-uptime',
    `    scheme: ${scheme}`,
    '    metrics_path: /metrics',
    '    scrape_interval: 60s',
    '    authorization:',
    '      type: Bearer',
    `      credentials: ${key}`,
    '    static_configs:',
    `      - targets: ['${host}']`,
  ].join('\n');
}

function keyExpired(k: ApiKey, now = Date.now()): boolean {
  return k.expiresAt !== null && k.expiresAt <= now;
}

export function ApiKeysCard() {
  const { data: keys, error, loading, reload } = useApi((signal) => securityApi.listApiKeys(signal), []);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const revoke = async (k: ApiKey) => {
    setBusy(true);
    setActionError(null);
    try {
      await securityApi.revokeApiKey(k.uid);
      setRevoking(null);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
      setRevoking(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>API keys</CardTitle>
        <CardDescription>Bearer tokens for scripts and Prometheus. A key acts with your permissions, limited to its scopes.</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            New key
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : loading && !keys ? (
          <SkeletonRows rows={2} className="px-4 pb-4" />
        ) : !keys || keys.length === 0 ? (
          <EmptyState title="No API keys" icon={<KeyRoundIcon />} className="border-t">
            Create a key to scrape uptime metrics with Prometheus or to read data from scripts.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead className="hidden md:table-cell">Scopes</TableHead>
                <TableHead className="hidden sm:table-cell">Last used</TableHead>
                <TableHead className="hidden lg:table-cell">Expires</TableHead>
                <TableHead className="w-24 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.uid}>
                  <TableCell className="max-w-0 pl-4">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="bidi-isolate truncate font-medium" title={k.name}>
                          {displayText(k.name) || 'Unnamed key'}
                        </span>
                        {keyExpired(k) ? (
                          <Badge variant="outline" className="text-poor">
                            Expired
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        pa_{displayText(k.prefix)}_••••
                        <span className="font-sans md:hidden"> · {k.scopes.map((s) => SCOPE_INFO[s].label).join(', ')}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">Created {formatDateLong(k.createdAt)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="secondary">
                          {SCOPE_INFO[s].label}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'Never'}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{k.expiresAt ? formatDateLong(k.expiresAt) : 'Never'}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button type="button" variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setRevoking(k)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {actionError ? <FormMessage className="px-4 py-2">{actionError}</FormMessage> : null}
      </CardContent>

      {creating ? <CreateKeyDialog onClose={() => setCreating(false)} onCreated={reload} /> : null}

      <AlertDialog open={revoking !== null} onOpenChange={(o) => (o ? undefined : setRevoking(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke <strong className="bidi-isolate break-all text-foreground">{revoking ? displayText(revoking.name) : ''}</strong>? Scripts and scrapers using it
              stop working immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy || !revoking} onClick={() => revoking && void revoke(revoking)}>
              Revoke key
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { config } = useAuth();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(() => new Set<ApiKeyScope>(['metrics']));
  const [expiry, setExpiry] = useState<string>('365');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const nameId = useId();
  const origin = config?.publicUrl || window.location.origin;

  const toggle = (s: ApiKeyScope, on: boolean) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (on) next.add(s);
      else next.delete(s);
      return next;
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the key a name.');
    if (scopes.size === 0) return setError('Choose at least one scope.');
    setBusy(true);
    setError(null);
    try {
      const body: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number } = {
        name: name.trim(),
        scopes: API_KEY_SCOPES.filter((s) => scopes.has(s)),
      };
      if (expiry !== 'never') body.expiresInDays = Number(expiry);
      setCreated(await securityApi.createApiKey(body));
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>API key created</DialogTitle>
              <DialogDescription>Copy the key now — it is shown only once. Treat it like a password.</DialogDescription>
            </DialogHeader>
            <SecretValue value={created.key} label="API key" wrap />
            {created.apiKey.scopes.includes('metrics') ? (
              <div className="flex min-w-0 flex-col gap-2">
                <p className="text-sm font-medium">Prometheus scrape config</p>
                <CodeBlock code={prometheusExample(origin, created.key)} />
              </div>
            ) : null}
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
              Anyone with this key can {created.apiKey.scopes.map((s) => SCOPE_INFO[s].label.toLowerCase()).join(' and ')} on your behalf. Revoke it if it leaks.
            </p>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={onSubmit} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
              <DialogDescription>Keys are scoped and can expire. You can revoke them at any time.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor={nameId}>Name</Label>
              <Input id={nameId} value={name} maxLength={100} placeholder="e.g. Prometheus" onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Scopes</legend>
              {API_KEY_SCOPES.map((s) => (
                <label key={s} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-data-checked:border-primary/30 has-data-checked:bg-primary/[0.03]">
                  <Switch checked={scopes.has(s)} onCheckedChange={(on) => toggle(s, on)} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5 text-sm">
                    <span className="font-medium">{SCOPE_INFO[s].label}</span>
                    <span className="text-xs text-muted-foreground">{SCOPE_INFO[s].help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-2">
              <Label>Expires</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(String(v))}>
                <SelectTrigger className="w-40" aria-label="Expiry">
                  <SelectValue>{(v: string) => EXPIRY_OPTIONS.find((o) => o.value === v)?.label ?? v}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
