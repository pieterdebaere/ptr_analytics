import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ActivityIcon, BellIcon, GlobeIcon, PlusIcon, WrenchIcon } from 'lucide-react';
import { api } from '@/api/client';
import { uptimeApi } from '@/api/uptime';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useLiveMonitors } from '@/components/uptime/live';
import { countByStatus } from '@/components/uptime/lib';
import { MonitorList, useMonitorFilters } from '@/components/uptime/MonitorList';
import { MonitorSuggestions } from '@/components/uptime/onboarding';
import { Toaster } from '@/components/uptime/toast';
import { LiveBadge, StatusCountCards } from '@/components/uptime/widgets';
import { useCanManageSites } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { cn } from '@/lib/utils';

export function UptimeOverviewPage() {
  const canManage = useCanManageSites();
  const live = useLiveMonitors((signal) => uptimeApi.overview(signal).then((r) => r.monitors), []);
  const sites = useApi((signal) => api.listSites(signal), []);
  const types = useApi((signal) => uptimeApi.types(signal), []);
  const typeLabels = useMemo(() => Object.fromEntries((types.data?.types ?? []).map((t) => [t.type, t.label])), [types.data]);
  const [filters, setFilters] = useMonitorFilters();
  const monitors = live.monitors;
  const counts = useMemo(() => countByStatus(monitors ?? []), [monitors]);

  useEffect(() => {
    const down = counts.down;
    document.title = down > 0 ? `(${down} down) Uptime – PTR Analytics` : 'Uptime – PTR Analytics';
    return () => {
      document.title = 'PTR Analytics';
    };
  }, [counts.down]);

  const siteCount = new Set((monitors ?? []).map((m) => m.siteId)).size;
  const newHref = filters.siteId ? `/monitors/new?site=${encodeURIComponent(filters.siteId)}` : '/monitors/new';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Uptime"
        description={
          monitors
            ? `${monitors.length} ${monitors.length === 1 ? 'monitor' : 'monitors'} across ${siteCount} ${siteCount === 1 ? 'site' : 'sites'}`
            : 'Availability, response times and certificates of your sites'
        }
        actions={
          <>
            <LiveBadge mode={live.mode} />
            <Link to="/maintenance" className={cn(buttonVariants({ variant: 'outline' }), 'bg-background')}>
              <WrenchIcon aria-hidden="true" />
              <span className="max-sm:sr-only">Maintenance</span>
            </Link>
            <Link to="/notifications" className={cn(buttonVariants({ variant: 'outline' }), 'bg-background')}>
              <BellIcon aria-hidden="true" />
              <span className="max-sm:sr-only">Notifications</span>
            </Link>
            {canManage && (sites.data?.length ?? 0) > 0 ? (
              <Link to={newHref} className={buttonVariants()}>
                <PlusIcon aria-hidden="true" />
                New monitor
              </Link>
            ) : null}
          </>
        }
      />

      {live.error && !monitors ? (
        <Card>
          <ErrorState message={live.error} onRetry={live.reload} />
        </Card>
      ) : !monitors ? (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className={cn('h-[86px] rounded-xl', i === 4 && 'col-span-2 sm:col-span-1')} />
            ))}
          </div>
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : monitors.length === 0 ? (
        <Card>
          {(sites.data?.length ?? 0) === 0 && !sites.loading ? (
            <EmptyState title="No sites yet" icon={<GlobeIcon />}>
              <p>Monitors belong to a site. Add a site first, then watch its availability, response time and certificate.</p>
              <Link to="/" className={cn(buttonVariants(), 'mt-4')}>
                Go to all sites
              </Link>
            </EmptyState>
          ) : (
            <EmptyState title="No monitors yet" icon={<ActivityIcon />}>
              <p>
                Check your websites, APIs and servers every minute from here and get notified when something goes down. Start with
                one of these, or pick any monitor type.
              </p>
              {canManage ? (
                <div className="mt-4 flex flex-col items-center gap-4">
                  <MonitorSuggestions sites={sites.data ?? []} onCreated={live.reload} />
                  <Link to="/monitors/new" className={buttonVariants({ variant: 'outline' })}>
                    <PlusIcon aria-hidden="true" />
                    Choose a monitor type
                  </Link>
                </div>
              ) : null}
            </EmptyState>
          )}
        </Card>
      ) : (
        <>
          <StatusCountCards counts={counts} active={filters.status ?? ''} onSelect={(s) => setFilters({ status: s })} />
          <MonitorList
            monitors={monitors}
            beats={live.beats}
            sites={sites.data}
            typeLabels={typeLabels}
            canManage={canManage}
            onChanged={live.replace}
            onRemoved={live.remove}
            onReload={live.reload}
          />
        </>
      )}
      <Toaster />
    </div>
  );
}
