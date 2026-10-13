import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Site } from '../api/types';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { ChevronDownIcon } from '../components/Icons';
import { EmptyState, ErrorState, Skeleton, useDismiss } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { isSiteId, periodSearch } from '../lib/query';
import { displayText } from '../lib/safety';

export interface SiteContext {
  site: Site;
  sites: Site[];
  reloadSites: () => void;
}

export function useSite(): SiteContext {
  return useOutletContext<SiteContext>();
}

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
      <div className="page">
        <Skeleton className="skeleton-title" />
        <Skeleton className="skeleton-chart" />
      </div>
    );
  }
  if (!site || !isSiteId(id)) {
    return (
      <div className="card">
        <EmptyState title="Site not found">
          <p>
            This site does not exist or was deleted. <Link to="/">Back to all sites</Link>
          </p>
        </EmptyState>
      </div>
    );
  }

  const base = `/sites/${encodeURIComponent(site.id)}`;
  const search = periodSearch(new URLSearchParams(location.search));
  // which tab is active -> keep it when switching sites
  const sub = location.pathname.endsWith('/speed') ? '/speed' : location.pathname.endsWith('/settings') ? '/settings' : '';

  const ctx: SiteContext = { site, sites: sites ?? [], reloadSites: reload };

  return (
    <div className="page">
      <div className="site-header">
        <div className="site-switcher">
          <SiteSwitcher
            current={site}
            sites={sites ?? []}
            hrefFor={(id) => `/sites/${encodeURIComponent(id)}${sub}${sub === '/settings' ? '' : search}`}
          />
          <span className="muted site-domains truncate bidi-isolate">{displayText(site.domains.join(', '))}</span>
        </div>
        <nav className="site-tabs" aria-label="Site sections">
          <NavLink end to={`${base}${search}`} className={({ isActive }) => `site-tab${isActive ? ' site-tab-active' : ''}`}>
            Analytics
          </NavLink>
          <NavLink to={`${base}/speed${search}`} className={({ isActive }) => `site-tab${isActive ? ' site-tab-active' : ''}`}>
            Speed Insights
          </NavLink>
          <NavLink to={`${base}/settings`} className={({ isActive }) => `site-tab${isActive ? ' site-tab-active' : ''}`}>
            Settings
          </NavLink>
        </nav>
      </div>
      <ErrorBoundary resetKey={location.pathname}>
        <Outlet context={ctx} />
      </ErrorBoundary>
    </div>
  );
}

function SiteSwitcher({ current, sites, hrefFor }: { current: Site; sites: Site[]; hrefFor: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div className="menu site-switch" ref={ref}>
      <button
        type="button"
        className="site-switch-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch site (current: ${displayText(current.name)})`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate bidi-isolate">{displayText(current.name)}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="menu-list menu-list-left" role="menu">
          {sites.map((s) => (
            <Link
              key={s.id}
              to={hrefFor(s.id)}
              role="menuitem"
              className={`menu-item site-switch-item${s.id === current.id ? ' menu-item-active' : ''}`}
              aria-current={s.id === current.id ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              <span className="truncate bidi-isolate">{displayText(s.name)}</span>
              <span className="muted small truncate bidi-isolate">{displayText(s.domains.join(', '))}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
