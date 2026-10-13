import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { CreditCardIcon, LogOutIcon, UserRoundIcon } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { roleLabel, useAuth, useShowBilling } from '@/hooks/auth';
import { loginUrl, displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from './ErrorBoundary';
import { ErrorState, Spinner } from './common';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

/** Page width shared by header, content and footer so edges line up. */
export const CONTAINER = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

function initials(email: string): string {
  const name = email.split('@')[0] ?? '';
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? (parts[0]![0] ?? '') + (parts[1]![0] ?? '') : name.slice(0, 2)) || '?';
  return displayText(letters.toUpperCase());
}

function UserMenu() {
  const { user, logout } = useAuth();
  const showBilling = useShowBilling();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account menu (${user.email})`} />}
      >
        <Avatar size="sm">
          <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">{initials(user.email)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1 py-1.5">
            <span className="bidi-isolate truncate text-sm font-medium text-foreground" title={user.email}>
              {displayText(user.email)}
            </span>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {roleLabel(user.role)}
            </Badge>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/settings" />}>
            <UserRoundIcon aria-hidden="true" />
            {user.role === 'admin' ? 'Account & users' : 'Account'}
          </DropdownMenuItem>
          {showBilling ? (
            <DropdownMenuItem render={<Link to="/billing" />}>
              <CreditCardIcon aria-hidden="true" />
              Billing
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void logout()}>
          <LogOutIcon aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavItem({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'inline-flex h-8 items-center rounded-md px-2.5 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          isActive && 'bg-muted text-foreground',
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function AppLayout() {
  const { user, config, error, retry } = useAuth();
  const showBilling = useShowBilling();
  const location = useLocation();

  if (user === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        {error ? <ErrorState message={error} onRetry={retry} /> : <Spinner />}
      </div>
    );
  }
  if (user === null) {
    return <Navigate to={loginUrl(location.pathname + location.search)} replace />;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header data-slot="navbar" className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/70">
        <div className={cn(CONTAINER, 'flex h-14 items-center gap-2')}>
          <Link to="/" className="mr-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="PTR Analytics home">
            <Logo compact />
          </Link>
          <nav className="flex items-center gap-1" aria-label="Main">
            <NavItem to="/" end>
              All sites
            </NavItem>
            {showBilling ? <NavItem to="/billing">Billing</NavItem> : null}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className={cn(CONTAINER, 'flex-1 py-6 sm:py-8')}>
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className={cn(CONTAINER, 'flex flex-wrap items-center justify-between gap-2 border-t py-5 text-xs text-muted-foreground')}>
        <span>PTR Analytics{config?.version ? ` v${config.version}` : ''}</span>
        {config?.geoip ? (
          <a className="hover:text-foreground" href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
            IP geolocation by DB-IP
          </a>
        ) : null}
      </footer>
    </div>
  );
}

/** Centered card layout for the public auth pages (login, sign-up, reset …). */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10 dark:bg-background">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <Link to="/login" className="mb-6 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label="PTR Analytics">
        <Logo className="text-lg" />
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
