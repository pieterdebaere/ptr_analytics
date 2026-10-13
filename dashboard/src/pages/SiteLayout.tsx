import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Site } from '../api/types';
import { EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { isSiteId, periodSearch } from '../lib/query';

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
  const navigate = useNavigate();
  const { data: sites, error, loading, reload } = useApi((signal) => api.listSites(signal), []);
  const site = sites?.find((s) => s.id === id);

  useEffect(() => {
    if (site) document.title = `${site.name} – PTR Analytics`;
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
          <label className="sr-only" htmlFor="site-switch">
            Switch site
          </label>
          <select
            id="site-switch"
            className="select select-title"
            value={site.id}
            onChange={(e) => navigate(`/sites/${encodeURIComponent(e.target.value)}${sub}${sub === '/settings' ? '' : search}`)}
          >
            {(sites ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="muted site-domains truncate">{site.domains.join(', ')}</span>
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
      <Outlet context={ctx} />
    </div>
  );
}
