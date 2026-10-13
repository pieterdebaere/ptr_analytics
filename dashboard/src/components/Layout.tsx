import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/useTheme';
import { loginUrl } from '../lib/safety';
import { ChevronDownIcon, LogoIcon, MoonIcon, SunIcon, UserIcon } from './Icons';
import { ErrorState, Spinner, useDismiss } from './ui';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={label} title={label}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  if (!user) return null;
  return (
    <div className="menu" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-sm menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <UserIcon />
        <span className="menu-email">{user.email}</span>
        <ChevronDownIcon />
      </button>
      {open ? (
        <div className="menu-list" role="menu">
          <div className="menu-meta">
            <div className="truncate">{user.email}</div>
            <div className="muted">{user.role === 'admin' ? 'Admin' : 'Viewer'}</div>
          </div>
          <Link to="/settings" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            Account{user.role === 'admin' ? ' & users' : ''}
          </Link>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppLayout() {
  const { user, config, error, retry } = useAuth();
  const location = useLocation();

  if (user === undefined) {
    return (
      <div className="fullpage-center">
        {error ? <ErrorState message={error} onRetry={retry} /> : <Spinner />}
      </div>
    );
  }
  if (user === null) {
    return <Navigate to={loginUrl(location.pathname + location.search)} replace />;
  }

  return (
    <div className="app">
      <header className="navbar">
        <div className="container navbar-inner">
          <Link to="/" className="brand" aria-label="PTR Analytics home">
            <LogoIcon />
            <span>PTR Analytics</span>
          </Link>
          <nav className="nav-links" aria-label="Main">
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`}>
              All sites
            </NavLink>
          </nav>
          <div className="navbar-right">
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="container main">
        <Outlet />
      </main>
      <footer className="footer container">
        <span>PTR Analytics{config?.version ? ` v${config.version}` : ''}</span>
        {config?.geoip ? (
          <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
            IP geolocation by DB-IP
          </a>
        ) : null}
      </footer>
    </div>
  );
}
