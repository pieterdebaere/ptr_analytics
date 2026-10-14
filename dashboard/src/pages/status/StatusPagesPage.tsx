// /status-pages — public status pages per site (docs/SPEC.md §8.3).
import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EllipsisIcon, ExternalLinkIcon, GlobeIcon, LayoutListIcon, PencilIcon, PlusIcon, RadioTowerIcon, Trash2Icon } from 'lucide-react';
import { api, errorMessage } from '@/api/client';
import { statusApi, type StatusPage } from '@/api/status';
import { FormMessage } from '@/components/AuthCard';
import { EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/common';
import { CreateStatusPageDialog, publicOrigin } from '@/components/status/CreateStatusPageDialog';
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth, useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';

const ALL = '__all__';

export function StatusPagesPage() {
  const { config } = useAuth();
  const canManage = useCanManageSites();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const pages = useApi((signal) => statusApi.list(signal), []);
  const sites = useApi((signal) => api.listSites(signal), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<StatusPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const origin = publicOrigin(config?.publicUrl);

  const siteMap = useMemo(() => new Map((sites.data ?? []).map((s) => [s.id, s])), [sites.data]);
  const siteFilter = params.get('site');
  const filter = siteFilter && siteMap.has(siteFilter) ? siteFilter : null;
  const list = (pages.data ?? []).filter((p) => !filter || p.siteId === filter).sort((a, b) => a.title.localeCompare(b.title));

  const setFilter = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === ALL) next.delete('site');
    else next.set('site', v);
    setParams(next, { replace: true });
  };

  const remove = async (p: StatusPage) => {
    setBusy(true);
    setActionError(null);
    try {
      await statusApi.remove(p.uid);
      setDeleting(null);
      pages.reload();
    } catch (e) {
      setActionError(errorMessage(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  const hasSites = (sites.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Status pages"
        description="Public pages that show your visitors whether your services are up."
        actions={
          <>
            {(sites.data?.length ?? 0) > 1 ? (
              <Select value={filter ?? ALL} onValueChange={(v) => setFilter(String(v))}>
                <SelectTrigger className="w-44" aria-label="Filter by site">
                  <SelectValue>
                    {(v: string) => (v === ALL ? 'All sites' : <span className="bidi-isolate truncate">{displayText(siteMap.get(v)?.name ?? '')}</span>)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>All sites</SelectItem>
                  {(sites.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="bidi-isolate truncate">{displayText(s.name)}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {canManage ? (
              <Button type="button" onClick={() => setCreating(true)} disabled={!hasSites}>
                <PlusIcon aria-hidden="true" />
                New status page
              </Button>
            ) : null}
          </>
        }
      />

      <Card className="gap-0 py-0">
        {pages.error ? (
          <ErrorState message={pages.error} onRetry={pages.reload} />
        ) : pages.loading && !pages.data ? (
          <SkeletonRows rows={3} className="p-4" />
        ) : list.length === 0 ? (
          <EmptyState title={filter ? 'No status pages for this site' : 'No status pages yet'} icon={<RadioTowerIcon />} className="py-14">
            <p>Share uptime with your users at a public address, post incidents and announce maintenance.</p>
            {canManage ? (
              hasSites ? (
                <Button type="button" className="mt-4" onClick={() => setCreating(true)}>
                  <PlusIcon aria-hidden="true" />
                  New status page
                </Button>
              ) : (
                <p className="mt-2">
                  <Link to="/" className="font-medium text-foreground underline underline-offset-4">
                    Add a site
                  </Link>{' '}
                  first.
                </p>
              )
            ) : null}
          </EmptyState>
        ) : (
          <ul className="divide-y" aria-label="Status pages">
            {list.map((p) => {
              const site = siteMap.get(p.siteId);
              const monitors = p.sections.reduce((n, s) => n + s.monitors.length, 0);
              const verifiedDomains = p.domains.filter((d) => d.verified);
              return (
                <li key={p.uid} className="flex items-center gap-3 px-4 py-3.5 sm:px-5" data-page={p.uid}>
                  <PageAvatar page={p} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <Link to={`/status-pages/${encodeURIComponent(p.uid)}`} className="bidi-isolate min-w-0 truncate font-medium outline-none hover:underline hover:underline-offset-4 focus-visible:underline">
                        {displayText(p.title) || 'Untitled'}
                      </Link>
                      {p.published ? <Badge className="bg-good/12 text-good">Published</Badge> : <Badge variant="secondary">Draft</Badge>}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      <span className="truncate font-mono">/status/{displayText(p.slug)}</span>
                      {site && !filter ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="bidi-isolate max-w-40 truncate">{displayText(site.name)}</span>
                        </>
                      ) : null}
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1">
                        <LayoutListIcon className="size-3" aria-hidden="true" />
                        {monitors} {monitors === 1 ? 'monitor' : 'monitors'}
                      </span>
                      {verifiedDomains.length > 0 ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex min-w-0 items-center gap-1">
                            <GlobeIcon className="size-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{displayText(verifiedDomains[0]!.domain)}</span>
                            {verifiedDomains.length > 1 ? <span>+{verifiedDomains.length - 1}</span> : null}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {p.published ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden sm:inline-flex"
                      render={<a href={`/status/${encodeURIComponent(p.slug)}`} target="_blank" rel="noopener noreferrer" />}
                      nativeButton={false}
                    >
                      <ExternalLinkIcon aria-hidden="true" />
                      View
                    </Button>
                  ) : null}
                  {canManage ? (
                    <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => navigate(`/status-pages/${encodeURIComponent(p.uid)}`)}>
                      <PencilIcon aria-hidden="true" />
                      Edit
                    </Button>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${p.title}`} />}>
                      <EllipsisIcon aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => navigate(`/status-pages/${encodeURIComponent(p.uid)}`)}>
                        <PencilIcon aria-hidden="true" />
                        {canManage ? 'Edit' : 'Open'}
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<a href={`/status/${encodeURIComponent(p.slug)}`} target="_blank" rel="noopener noreferrer" />} disabled={!p.published}>
                        <ExternalLinkIcon aria-hidden="true" />
                        View public page
                      </DropdownMenuItem>
                      {canManage ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(p)}>
                            <Trash2Icon aria-hidden="true" />
                            Delete
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {actionError ? <FormMessage>{actionError}</FormMessage> : null}

      {creating && sites.data ? (
        <CreateStatusPageDialog
          sites={sites.data}
          defaultSiteId={filter}
          origin={origin}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            navigate(`/status-pages/${encodeURIComponent(p.uid)}`);
          }}
        />
      ) : null}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => (o ? undefined : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete status page</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong className="bidi-isolate break-all text-foreground">{deleting ? displayText(deleting.title) : ''}</strong> with its incidents and custom
              domains? The public address stops working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy || !deleting} onClick={() => deleting && void remove(deleting)}>
              Delete page
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PageAvatar({ page }: { page: StatusPage }) {
  if (page.logoUrl) {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-background">
        <img src={page.logoUrl} alt="" className="max-h-7 max-w-7 object-contain" />
      </span>
    );
  }
  const letter = displayText(page.title.trim().charAt(0).toUpperCase() || '?');
  const style = page.accent ? ({ backgroundColor: page.accent } as CSSProperties) : undefined;
  return (
    <span
      className={page.accent ? 'flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white' : 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground'}
      style={style}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}
