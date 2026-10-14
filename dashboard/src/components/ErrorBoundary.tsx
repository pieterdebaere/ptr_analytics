// Catches render/effect errors so a crash shows a friendly message instead of
// a blank page. Rendered without router hooks so it also works above the router.
import { Component, type ErrorInfo, type MouseEvent, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 'app' fills the whole page (top level); 'page' renders inside the shell. */
  variant?: 'app' | 'page';
  /** When this value changes (e.g. the route), a caught error is cleared. */
  resetKey?: unknown;
}

interface State {
  error: unknown;
  hasError: boolean;
}

function reload(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  window.location.reload();
}

/** Same-origin URL of the current page for the reload link (never external). */
function currentHref(): string {
  try {
    const { pathname, search, hash } = window.location;
    const path = pathname + search + hash;
    return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
  } catch {
    return '/';
  }
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.hasError && !Object.is(prev.resetKey, this.props.resetKey)) {
      this.setState({ error: null, hasError: false });
    }
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const app = this.props.variant === 'app';
    const Heading = app ? 'h1' : 'h2';
    const link =
      'font-medium text-foreground underline underline-offset-4 hover:text-foreground/80';
    return (
      <div
        role="alert"
        className={
          app
            ? 'flex min-h-dvh flex-col items-center justify-center gap-2 p-6 text-center'
            : 'flex flex-col items-center gap-2 rounded-xl px-6 py-12 text-center ring-1 ring-foreground/10'
        }
      >
        <Heading className="text-lg font-semibold">Something went wrong</Heading>
        <p className="text-sm text-muted-foreground">An unexpected error occurred while showing this page.</p>
        <p className="text-sm">
          <a className={link} href={currentHref()} onClick={reload}>
            Reload the page
          </a>
          {app ? null : (
            <>
              <span className="text-muted-foreground">{' · '}</span>
              <a className={link} href="/">
                Back to all sites
              </a>
            </>
          )}
        </p>
      </div>
    );
  }
}
