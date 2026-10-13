import { Link, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/Layout';
import { EmptyState } from './components/ui';
import { AuthProvider } from './hooks/auth';
import { AccountPage } from './pages/AccountPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { SiteAnalyticsPage } from './pages/SiteAnalyticsPage';
import { SiteLayout } from './pages/SiteLayout';
import { SiteSettingsPage } from './pages/SiteSettingsPage';
import { SpeedInsightsPage } from './pages/SpeedInsightsPage';

function NotFound() {
  return (
    <div className="card">
      <EmptyState title="Page not found">
        <p>
          <Link to="/">Back to all sites</Link>
        </p>
      </EmptyState>
    </div>
  );
}

/** Routes; must be rendered inside a Router. */
export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="sites/:id" element={<SiteLayout />}>
            <Route index element={<SiteAnalyticsPage />} />
            <Route path="speed" element={<SpeedInsightsPage />} />
            <Route path="settings" element={<SiteSettingsPage />} />
          </Route>
          <Route path="settings" element={<AccountPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}
