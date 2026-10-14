import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { CreditCardIcon, LogOutIcon, ShieldCheckIcon, UserRoundIcon } from 'lucide-react';
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
          <DropdownMenuItem render={<Link to="/settings/security" />}>
            <ShieldCheckIcon aria-hidden="true" />
            Security
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
          'inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
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
  const navRef = useRef<HTMLElement>(null);
  // Mobile: the nav is a horizontally scrolling row. Keep the active item in view and fade
  // the edge that has more items behind it (scroll cue).
  const [fade, setFade] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const updateFade = () => {
    const nav = navRef.current;
    if (!nav) return;
    const max = nav.scrollWidth - nav.clientWidth;
    const next = { start: max > 1 && nav.scrollLeft > 1, end: max > 1 && nav.scrollLeft < max - 1 };
    setFade((f) => (f.start === next.start && f.end === next.end ? f : next));
  };
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active && nav.scrollWidth > nav.clientWidth) {
      const left = active.offsetLeft - nav.offsetLeft;
      if (left < nav.scrollLeft || left + active.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = left - 16;
    }
    updateFade();
  }, [location.pathname, user]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener('resize', updateFade);
    return () => window.removeEventListener('resize', updateFade);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className={cn(CONTAINER, 'flex flex-wrap items-center gap-x-2 md:h-14 md:flex-nowrap')}>
          <Link
            to="/"
            className="mr-2 inline-flex h-14 min-w-8 items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9"
            aria-label="PTR Analytics home"
          >
            <Logo compact />
          </Link>
          {/* < md: second row that scrolls sideways; >= md: inline after the logo */}
          <nav
            ref={navRef}
            onScroll={updateFade}
            className={cn(
              'scrollbar-none order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto border-t px-4 py-1.5 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 md:order-none md:mx-0 md:w-auto md:border-t-0 md:p-0',
              fade.end && !fade.start && 'mask-r-from-[calc(100%-2.5rem)]',
              fade.start && !fade.end && 'mask-l-from-[calc(100%-2.5rem)]',
              fade.start && fade.end && 'mask-x-from-[calc(100%-2.5rem)]',
            )}
            aria-label="Main"
          >
            <NavItem to="/" end>
              All sites
            </NavItem>
            <NavItem to="/uptime">Uptime</NavItem>
            <NavItem to="/status-pages">Status pages</NavItem>
            <NavItem to="/notifications">Notifications</NavItem>
            <NavItem to="/maintenance">Maintenance</NavItem>
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
      <footer className="border-t">
        <div className={cn(CONTAINER, 'flex flex-wrap items-center justify-between gap-2 py-5 text-xs text-muted-foreground')}>
        <span>PTR Analytics{config?.version ? ` v${config.version}` : ''}</span>
        {config?.geoip ? (
          <a className="hover:text-foreground" href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
            IP geolocation by DB-IP
          </a>
        ) : null}
        </div>
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
