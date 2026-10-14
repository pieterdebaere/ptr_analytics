import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { CheckIcon, ChevronsUpDownIcon, LayoutGridIcon, PauseCircleIcon } from 'lucide-react';
import { api } from '@/api/client';
import type { Site } from '@/api/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { EmptyState, ErrorState } from '@/components/common';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth, useShowBilling } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { isSiteId, periodSearch } from '@/lib/query';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

export interface SiteContext {
  site: Site;
  sites: Site[];
  reloadSites: () => void;
}

export function useSite(): SiteContext {
  return useOutletContext<SiteContext>();
}

const SUBPAGES = ['/live', '/speed', '/settings'] as const;

export function SiteLayout() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { data: sites, error, loading, reload } = useApi((signal) => api.listSites(signal), []);
  const site = sites?.find((s) => s.id === id);

  useEffect(() => {
    if (site) document.title = `${displayText(site.name)} – PTR Analytics`;
    return () => {
      document.title = 'PTR Analytics';
    };
  }, [site]);

  if (error && !sites) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !sites) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-80 w-full rounded-xl" />
      </div>
    );
  }
  if (!site || !isSiteId(id)) {
    return (
      <div className="rounded-xl ring-1 ring-foreground/10">
        <EmptyState title="Site not found">
          <p>
            This site does not exist or was deleted.{' '}
            <Link to="/" className="font-medium text-foreground underline underline-offset-4">
              Back to all sites
            </Link>
          </p>
        </EmptyState>
      </div>
    );
  }

  const base = `/sites/${encodeURIComponent(site.id)}`;
  const search = periodSearch(new URLSearchParams(location.search));
  // which tab is active -> keep it when switching sites
  const sub = SUBPAGES.find((s) => location.pathname.endsWith(s)) ?? '';
  const keepSearch = sub === '' || sub === '/speed';

  const ctx: SiteContext = { site, sites: sites ?? [], reloadSites: reload };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <SiteSwitcher
            current={site}
            sites={sites ?? []}
            hrefFor={(sid) => `/sites/${encodeURIComponent(sid)}${sub}${keepSearch ? search : ''}`}
          />
          <p className="bidi-isolate truncate text-sm text-muted-foreground">{displayText(site.domains.join(', '))}</p>
        </div>
        <nav className="scrollbar-none -mb-px flex gap-1 overflow-x-auto border-b" aria-label="Site sections">
          <SiteTab to={`${base}${search}`} end>
            Analytics
          </SiteTab>
          <SiteTab to={`${base}/live`}>
            <span className="relative mr-0.5 inline-flex size-1.5 rounded-full bg-live" aria-hidden="true" />
            Live
          </SiteTab>
          <SiteTab to={`${base}/speed${search}`}>Speed Insights</SiteTab>
          <SiteTab to={`${base}/uptime`}>Uptime</SiteTab>
          <SiteTab to={`${base}/settings`}>Settings</SiteTab>
        </nav>
      </div>
      {site.suspended ? <SuspendedBanner /> : null}
      <ErrorBoundary resetKey={location.pathname}>
        <Outlet context={ctx} />
      </ErrorBoundary>
    </div>
  );
}

function SiteTab({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'relative inline-flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity',
          isActive && 'text-foreground after:opacity-100',
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function SuspendedBanner() {
  const showBilling = useShowBilling();
  const { user } = useAuth();
  return (
    <Alert className="border-warn/40 bg-warn/8 text-foreground" data-slot="suspended-banner">
      <PauseCircleIcon className="text-warn-text" aria-hidden="true" />
      <AlertTitle>This site is suspended</AlertTitle>
      <AlertDescription>
        <p>
          It is beyond the number of sites included in {user?.role === 'member' ? 'your' : 'the owner’s'} plan, so new visits
          are not recorded. Existing data is kept.{' '}
          {showBilling ? (
            <Link to="/billing" className="font-medium">
              Add a paid site to reactivate it
            </Link>
          ) : null}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function SiteSwitcher({ current, sites, hrefFor }: { current: Site; sites: Site[]; hrefFor: (id: string) => string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="-ml-2 flex h-10 max-w-full min-w-0 items-center gap-1.5 self-start rounded-lg px-2 text-left text-2xl font-semibold tracking-tight outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
        aria-label={`Switch site (current: ${displayText(current.name)})`}
      >
        <span className="bidi-isolate truncate">{displayText(current.name)}</span>
        {current.suspended ? (
          <Badge variant="outline" className="border-warn/50 text-warn-text">
            Suspended
          </Badge>
        ) : null}
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sites</DropdownMenuLabel>
          {sites.map((s) => (
            <DropdownMenuItem key={s.id} render={<Link to={hrefFor(s.id)} aria-current={s.id === current.id ? 'page' : undefined} />} className="items-start py-1.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="bidi-isolate truncate font-medium">{displayText(s.name)}</span>
                <span className="bidi-isolate truncate text-xs text-muted-foreground">{displayText(s.domains.join(', '))}</span>
              </span>
              {s.id === current.id ? <CheckIcon className="mt-0.5" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/" />}>
          <LayoutGridIcon aria-hidden="true" />
          All sites
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

