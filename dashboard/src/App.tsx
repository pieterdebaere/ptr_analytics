import { lazy, Suspense } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppLayout } from './components/Layout';
import { EmptyState, Spinner } from './components/common';
import { AuthProvider } from './hooks/auth';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { SiteAnalyticsPage } from './pages/SiteAnalyticsPage';
import { SiteLayout } from './pages/SiteLayout';

// Less frequently used screens are split into their own chunks.
const AccountPage = lazy(() => import('./pages/AccountPage').then((m) => ({ default: m.AccountPage })));
const BillingPage = lazy(() => import('./pages/BillingPage').then((m) => ({ default: m.BillingPage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const SignupPage = lazy(() => import('./pages/SignupPage').then((m) => ({ default: m.SignupPage })));
const SiteLivePage = lazy(() => import('./pages/SiteLivePage').then((m) => ({ default: m.SiteLivePage })));
const SiteSettingsPage = lazy(() => import('./pages/SiteSettingsPage').then((m) => ({ default: m.SiteSettingsPage })));
const SpeedInsightsPage = lazy(() => import('./pages/SpeedInsightsPage').then((m) => ({ default: m.SpeedInsightsPage })));
const UptimeOverviewPage = lazy(() => import('./pages/uptime/UptimeOverviewPage').then((m) => ({ default: m.UptimeOverviewPage })));
const SiteUptimePage = lazy(() => import('./pages/uptime/SiteUptimePage').then((m) => ({ default: m.SiteUptimePage })));
const MonitorPage = lazy(() => import('./pages/uptime/MonitorPage').then((m) => ({ default: m.MonitorPage })));
const MonitorEditPage = lazy(() => import('./pages/uptime/MonitorEditPage').then((m) => ({ default: m.MonitorEditPage })));
const MaintenancePage = lazy(() => import('./pages/uptime/MaintenancePage').then((m) => ({ default: m.MaintenancePage })));
const NotificationsPage = lazy(() => import('./pages/notify/NotificationsPage').then((m) => ({ default: m.NotificationsPage })));
const StatusPagesPage = lazy(() => import('./pages/status/StatusPagesPage').then((m) => ({ default: m.StatusPagesPage })));
const StatusPageEditorPage = lazy(() => import('./pages/status/StatusPageEditorPage').then((m) => ({ default: m.StatusPageEditorPage })));
const PublicStatusPage = lazy(() => import('./pages/status/PublicStatusPage').then((m) => ({ default: m.PublicStatusPage })));
const SecurityPage = lazy(() => import('./pages/security/SecurityPage').then((m) => ({ default: m.SecurityPage })));
const VerifyPage = lazy(() => import('./pages/VerifyPage').then((m) => ({ default: m.VerifyPage })));

function NotFound() {
  return (
    <div className="rounded-xl ring-1 ring-foreground/10">
      <EmptyState title="Page not found">
        <p>
          <Link to="/" className="font-medium text-foreground underline underline-offset-4">
            Back to all sites
          </Link>
        </p>
      </EmptyState>
    </div>
  );
}

/** Routes; must be rendered inside a Router. */
export function App() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary variant="app" resetKey={pathname}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ErrorBoundary>
  );
}

function PageFallback() {
  return (
    <div className="flex min-h-48 items-center justify-center">
      <Spinner />
    </div>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/forgot" element={<ForgotPasswordPage />} />
      <Route path="/reset" element={<ResetPasswordPage />} />
      {/* Public status pages: no login, no app chrome. */}
      <Route path="/status/:slug" element={<PublicStatusPage />} />
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="sites/:id" element={<SiteLayout />}>
          <Route index element={<SiteAnalyticsPage />} />
          <Route path="live" element={<SiteLivePage />} />
          <Route path="speed" element={<SpeedInsightsPage />} />
          <Route path="uptime" element={<SiteUptimePage />} />
          <Route path="settings" element={<SiteSettingsPage />} />
        </Route>
        <Route path="uptime" element={<UptimeOverviewPage />} />
        <Route path="monitors/new" element={<MonitorEditPage />} />
        <Route path="monitors/:uid" element={<MonitorPage />} />
        <Route path="monitors/:uid/edit" element={<MonitorEditPage />} />
        <Route path="maintenance" element={<MaintenancePage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="status-pages" element={<StatusPagesPage />} />
        <Route path="status-pages/:uid" element={<StatusPageEditorPage />} />
        <Route path="settings" element={<AccountPage />} />
        <Route path="settings/security" element={<SecurityPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
