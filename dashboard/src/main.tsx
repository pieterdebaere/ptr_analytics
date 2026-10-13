import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TooltipProvider } from './components/ui/tooltip';
import { applyStoredTheme } from './hooks/useTheme';
import './index.css';

applyStoredTheme();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary variant="app">
        {/* Strict CSP (style-src 'self'): Base UI must not render inline <style> elements;
            the rules they would contain live in index.css. */}
        <CSPProvider disableStyleElements>
          <TooltipProvider delay={300}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </TooltipProvider>
        </CSPProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}
