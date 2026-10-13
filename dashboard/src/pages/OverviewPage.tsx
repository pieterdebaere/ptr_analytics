import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { GlobeIcon, PlusIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { OverviewSite } from '@/api/types';
import { AddSiteModal } from '@/components/AddSiteModal';
import { ChangeBadge, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { LiveOverviewCard } from '@/components/live';
import { PeriodSelector } from '@/components/PeriodSelector';
import { Sparkline } from '@/components/stats-charts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { useStatsQuery } from '@/hooks/useStatsQuery';
import { formatCompact, formatNumber, percentChange } from '@/lib/format';
import { PERIOD_LABELS, periodSearch } from '@/lib/query';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

export function OverviewPage() {
  const canManage = useCanManageSites();
  const { period, setPeriod, tz, params } = useStatsQuery();
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useApi(
    (signal) => api.overview({ ...period, tz }, signal),
    [period.period, period.from, period.to, tz],
  );
  // Site list for the `suspended` flag (hosted mode); optional.
  const siteList = useApi((signal) => api.listSites(signal), []);
  const suspended = useMemo(() => new Set((siteList.data ?? []).filter((s) => s.suspended).map((s) => s.id)), [siteList.data]);
  const search = periodSearch(params);
  const sites = data?.sites ?? [];
  const sorted = [...sites].sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name));
  const siteHref = (id: string) => `/sites/${encodeURIComponent(id)}${search}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="All sites"
        description={PERIOD_LABELS[period.period]}
        actions={
          <>
            <PeriodSelector value={period} onChange={setPeriod} />
            {canManage ? (
              <Button type="button" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden="true" />
                Add site
              </Button>
            ) : null}
          </>
        }
      />

      {sorted.length > 0 ? <LiveOverviewCard siteHref={(id) => `/sites/${encodeURIComponent(id)}/live`} /> : null}

      {error ? (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      ) : loading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState title="No sites yet" icon={<GlobeIcon />}>
            {canManage ? (
              <>
                <p>
                  Add your first website: give it a name and the domains it is served from. You then get a one-line script
                  tag to put in the <code>&lt;head&gt;</code> of your pages — visits show up here within seconds.
                </p>
                <Button type="button" className="mt-4" onClick={() => setAdding(true)}>
                  <PlusIcon aria-hidden="true" />
                  Add your first site
                </Button>
              </>
            ) : (
              <p>No websites have been connected yet. Ask an admin to add one.</p>
            )}
          </EmptyState>
        </Card>
      ) : (
        <div className={cn('grid gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-3', loading && 'opacity-60')}>
          {sorted.map((s) => (
            <SiteCard key={s.id} site={s} suspended={suspended.has(s.id)} href={siteHref(s.id)} />
          ))}
        </div>
      )}

      {adding ? (
        <AddSiteModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            reload();
            siteList.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function SiteCard({ site, href, suspended }: { site: OverviewSite; href: string; suspended: boolean }) {
  const change = percentChange(site.visitors, site.previousVisitors);
  return (
    <Link
      to={href}
      data-slot="site-card"
      className="group/site flex flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 outline-none transition-shadow hover:ring-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div data-slot="site-card-name" className="bidi-isolate truncate font-medium">
            {displayText(site.name)}
          </div>
          <div className="bidi-isolate truncate text-xs text-muted-foreground">{displayText(site.domains.join(', '))}</div>
        </div>
        {suspended ? (
          <Badge variant="outline" className="shrink-0 border-warn/50 text-warn">
            Suspended
          </Badge>
        ) : null}
      </div>
      <Sparkline values={site.series} label={`Visitors trend for ${displayText(site.name)}`} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-muted-foreground">Visitors</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xl font-semibold tracking-tight tabular-nums" title={formatNumber(site.visitors)}>
              {formatCompact(site.visitors)}
            </span>
            <ChangeBadge change={change} />
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Page views</div>
          <div className="text-xl font-semibold tracking-tight tabular-nums" title={formatNumber(site.pageviews)}>
            {formatCompact(site.pageviews)}
          </div>
        </div>
      </div>
    </Link>
  );
}
