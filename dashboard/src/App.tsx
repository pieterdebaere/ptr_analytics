import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppLayout } from './components/Layout';
import { EmptyState } from './components/common';
import { AuthProvider } from './hooks/auth';
import { AccountPage } from './pages/AccountPage';
import { BillingPage } from './pages/BillingPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SignupPage } from './pages/SignupPage';
import { SiteAnalyticsPage } from './pages/SiteAnalyticsPage';
import { SiteLayout } from './pages/SiteLayout';
import { SiteLivePage } from './pages/SiteLivePage';
import { SiteSettingsPage } from './pages/SiteSettingsPage';
import { SpeedInsightsPage } from './pages/SpeedInsightsPage';
import { VerifyPage } from './pages/VerifyPage';

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

function AppRoutes() {
  return (
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
  );
}
