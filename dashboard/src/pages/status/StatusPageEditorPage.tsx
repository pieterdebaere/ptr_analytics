// /status-pages/:uid — status page editor (General, Monitors, Incidents, Custom domains, Badges).
// General + Monitors form one draft saved with a single PATCH; logo, domains and incidents
// are saved immediately.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon, EyeIcon, ExternalLinkIcon, SaveIcon } from 'lucide-react';
import { ApiError, api, errorMessage } from '@/api/client';
import { statusApi, type StatusPage } from '@/api/status';
import { uptimeApi } from '@/api/uptime';
import { FormMessage } from '@/components/AuthCard';
import { ErrorState, SkeletonRows } from '@/components/common';
import { publicOrigin } from '@/components/status/CreateStatusPageDialog';
import { BadgesTab } from '@/components/status/editor/BadgesTab';
import { DomainsTab } from '@/components/status/editor/DomainsTab';
import { draftOf, draftToInput, sameDraft, validateDraft, type Draft, type DraftErrors } from '@/components/status/editor/draft';
import { GeneralTab } from '@/components/status/editor/GeneralTab';
import { IncidentsTab } from '@/components/status/editor/IncidentsTab';
import { MonitorsTab } from '@/components/status/editor/MonitorsTab';
import { SHEET_CLASS } from '@/components/notify/DeliveryLogSheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth, useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { StatusContent, StatusShell } from './PublicStatusPage';

const TABS = ['general', 'monitors', 'incidents', 'domains', 'badges'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { general: 'General', monitors: 'Monitors', incidents: 'Incidents', domains: 'Custom domains', badges: 'Badges' };

function isTab(v: unknown): v is Tab {
  return (TABS as readonly unknown[]).includes(v);
}

export function StatusPageEditorPage() {
  const { uid = '' } = useParams();
  const { config } = useAuth();
  const readOnly = !useCanManageSites();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'general';
  const origin = publicOrigin(config?.publicUrl);

  const loaded = useApi((signal) => statusApi.get(uid, signal), [uid]);
  const [page, setPage] = useState<StatusPage | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<DraftErrors>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (loaded.data) {
      setPage(loaded.data);
      setDraft(draftOf(loaded.data));
    }
  }, [loaded.data]);

  const sites = useApi((signal) => api.listSites(signal), []);
  const siteId = page?.siteId ?? null;
  const monitors = useApi((signal) => uptimeApi.siteMonitors(siteId ?? '', signal), [siteId], siteId !== null);

  const baseline = useMemo(() => (page ? draftOf(page) : null), [page]);
  const dirty = !!draft && !!baseline && !sameDraft(draft, baseline);
  const errors: DraftErrors = draft ? { ...validateDraft(draft), ...serverErrors } : {};
  const hasErrors = Object.keys(errors).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setSaveError(null);
    if ('slug' in patch) setServerErrors((e) => ({ ...e, slug: undefined }));
  };

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'general') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };

  const save = async () => {
    if (!draft || !page) return;
    const v = validateDraft(draft);
    if (Object.keys(v).length > 0) {
      setTab(v.sections && !v.title && !v.slug && !v.description && !v.footer ? 'monitors' : 'general');
      setSaveError('Fix the highlighted fields first.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await statusApi.update(page.uid, draftToInput(draft));
      setPage(saved);
      setDraft(draftOf(saved));
      setServerErrors({});
      setSavedAt(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && /slug/i.test(e.message)) {
        setServerErrors({ slug: 'This address is already taken.' });
        setTab('general');
      } else if (e instanceof ApiError && /^slug/i.test(e.message)) {
        setServerErrors({ slug: e.message });
        setTab('general');
      } else if (e instanceof ApiError && /monitor|section/i.test(e.message)) {
        setServerErrors({ sections: e.message });
        setTab('monitors');
      }
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (baseline) setDraft(baseline);
    setServerErrors({});
    setSaveError(null);
  };

  if (loaded.error && !page) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-xl ring-1 ring-foreground/10">
          <ErrorState message={loaded.error} onRetry={loaded.reload} />
        </div>
      </div>
    );
  }
  if (!page || !draft) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const publicPath = `/status/${encodeURIComponent(page.slug)}`;
  let publicHost = 'this server';
  try {
    publicHost = new URL(origin).host;
  } catch {
    /* keep the fallback */
  }

  return (
    <div className="flex flex-col gap-6 pb-20">
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="bidi-isolate min-w-0 truncate text-2xl font-semibold tracking-tight">{displayText(page.title) || 'Untitled'}</h1>
              {page.published ? <Badge className="bg-good/12 text-good">Published</Badge> : <Badge variant="secondary">Draft</Badge>}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {origin}
              {publicPath}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setPreview(true)}>
              <EyeIcon aria-hidden="true" />
              Preview
            </Button>
            {page.published ? (
              <Button variant="outline" render={<a href={publicPath} target="_blank" rel="noopener noreferrer" />} nativeButton={false}>
                <ExternalLinkIcon aria-hidden="true" />
                View public page
              </Button>
            ) : null}
            {!readOnly ? (
              <Button type="button" onClick={() => void save()} disabled={!dirty || saving}>
                <SaveIcon aria-hidden="true" />
                {saving ? 'Saving…' : savedAt ? 'Saved' : 'Save changes'}
              </Button>
            ) : null}
          </div>
        </div>
        {saveError && !dirty ? <FormMessage>{saveError}</FormMessage> : null}
      </div>

      <Tabs value={tab} onValueChange={(v) => isTab(v) && setTab(v)} className="gap-5">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
          <TabsList variant="line" className="w-max min-w-full justify-start border-b pb-1 sm:min-w-0">
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t} className="flex-none px-2.5">
                {TAB_LABELS[t]}
                {t === 'general' && (errors.title || errors.slug || errors.description || errors.footer) ? (
                  <span className="size-1.5 rounded-full bg-destructive" aria-label="has errors" />
                ) : null}
                {t === 'monitors' && errors.sections ? <span className="size-1.5 rounded-full bg-destructive" aria-label="has errors" /> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="general">
          <GeneralTab
            draft={draft}
            update={update}
            errors={errors}
            page={page}
            sites={sites.data ?? []}
            origin={origin}
            onPageChange={setPage}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="monitors">
          <MonitorsTab
            sections={draft.sections}
            onChange={(sections) => update({ sections })}
            monitors={monitors.data}
            monitorsError={monitors.error}
            onRetry={monitors.reload}
            error={errors.sections}
            readOnly={readOnly}
          />
        </TabsContent>
        <TabsContent value="incidents">
          <IncidentsTab pageUid={page.uid} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="domains">
          <DomainsTab page={page} onPageChange={(p) => setPage(p)} publicHost={publicHost} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="badges">
          <BadgesTab page={page} origin={origin} />
        </TabsContent>
      </Tabs>

      {dirty && !readOnly ? (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4" data-slot="save-bar">
          <div className="flex w-full max-w-xl items-center gap-3 rounded-xl border bg-popover/95 py-2 pr-2 pl-4 text-sm shadow-lg ring-1 ring-foreground/5 backdrop-blur-sm animate-in fade-in-0 slide-in-from-bottom-2">
            <span className={cn('min-w-0 flex-1 truncate', saveError || hasErrors ? 'text-destructive' : 'text-muted-foreground')}>
              {saveError ?? (hasErrors ? 'Some fields need attention.' : 'You have unsaved changes.')}
            </span>
            <Button type="button" variant="ghost" onClick={discard} disabled={saving}>
              Discard
            </Button>
            <Button type="button" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : null}

      {preview ? <PreviewSheet page={page} onClose={() => setPreview(false)} dirty={dirty} /> : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/status-pages" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      Status pages
    </Link>
  );
}

/** The saved page as visitors see it (works for unpublished pages too). */
function PreviewSheet({ page, onClose, dirty }: { page: StatusPage; onClose: () => void; dirty: boolean }) {
  const { data, error, loading, reload } = useApi((signal) => statusApi.preview(page.uid, signal), [page.uid]);
  const [fetchedAt] = useState(() => Date.now());
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={cn(SHEET_CLASS, 'sm:max-w-4xl')}>
        <DialogHeader className="border-b px-4 py-3 pr-12 sm:px-5">
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>{dirty ? 'Showing the last saved version — save to see your changes.' : 'As visitors see it (in your dashboard theme).'}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : loading || !data ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : (
            <StatusShell accent={data.accent} className="min-h-full">
              <StatusContent data={data} slug={page.slug} fetchedAt={fetchedAt} refreshError={false} refreshing={loading} onRefresh={reload} />
            </StatusShell>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
