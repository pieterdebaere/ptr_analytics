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
      <Route element={<AppLayout />}>
        <Route index element={<OverviewPage />} />
        <Route path="sites/:id" element={<SiteLayout />}>
          <Route index element={<SiteAnalyticsPage />} />
          <Route path="live" element={<SiteLivePage />} />
          <Route path="speed" element={<SpeedInsightsPage />} />
          <Route path="settings" element={<SiteSettingsPage />} />
        </Route>
        <Route path="settings" element={<AccountPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </Suspense>
  );
}
