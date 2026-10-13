import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { OverviewSite } from '../api/types';
import { AddSiteModal } from '../components/AddSiteModal';
import { Sparkline } from '../components/charts';
import { PlusIcon } from '../components/Icons';
import { PeriodSelector } from '../components/PeriodSelector';
import { ChangeBadge, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { useIsAdmin } from '../hooks/auth';
import { useApi } from '../hooks/useApi';
import { useStatsQuery } from '../hooks/useStatsQuery';
import { formatCompact, formatNumber, percentChange } from '../lib/format';
import { PERIOD_LABELS, periodSearch } from '../lib/query';
import { displayText } from '../lib/safety';

export function OverviewPage() {
  const isAdmin = useIsAdmin();
  const { period, setPeriod, tz, params } = useStatsQuery();
  const [adding, setAdding] = useState(false);
  const { data, error, loading, reload } = useApi(
    (signal) => api.overview({ ...period, tz }, signal),
    [period.period, period.from, period.to, tz],
  );
  const search = periodSearch(params);
  const sites = data?.sites ?? [];
  const sorted = [...sites].sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">All sites</h1>
          <p className="muted">{PERIOD_LABELS[period.period]}</p>
        </div>
        <div className="page-actions">
          <PeriodSelector value={period} onChange={setPeriod} />
          {isAdmin ? (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              <PlusIcon />
              <span>Add site</span>
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="site-list">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="skeleton-card" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="card">
          <EmptyState title="No sites yet">
            {isAdmin ? (
              <>
                <p>
                  Add your first website with <strong>Add site</strong>: give it a name and the domains it is served
                  from. You then get a one-line script tag to put in the <code>&lt;head&gt;</code> of your pages —
                  visits show up here within seconds.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                  <PlusIcon />
                  <span>Add your first site</span>
                </button>
              </>
            ) : (
              <p>No websites have been connected yet. Ask an admin to add one.</p>
            )}
          </EmptyState>
        </div>
      ) : (
        <div className={`site-list${loading ? ' is-loading' : ''}`}>
          {sorted.map((s) => (
            <SiteCard key={s.id} site={s} href={`/sites/${encodeURIComponent(s.id)}${search}`} />
          ))}
        </div>
      )}

      {adding ? (
        <AddSiteModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function SiteCard({ site, href }: { site: OverviewSite; href: string }) {
  const change = percentChange(site.visitors, site.previousVisitors);
  return (
    <Link to={href} className="card site-card">
      <div className="site-card-main">
        <div className="site-card-name truncate bidi-isolate">{displayText(site.name)}</div>
        <div className="site-card-domains muted truncate bidi-isolate">{displayText(site.domains.join(', '))}</div>
      </div>
      <div className="site-card-spark">
        <Sparkline values={site.series} label={`Visitors trend for ${displayText(site.name)}`} />
      </div>
      <div className="site-card-stats">
        <div className="stat">
          <div className="stat-label">Visitors</div>
          <div className="stat-value">
            <span title={formatNumber(site.visitors)}>{formatCompact(site.visitors)}</span>
            <ChangeBadge change={change} />
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Page views</div>
          <div className="stat-value">
            <span title={formatNumber(site.pageviews)}>{formatCompact(site.pageviews)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
