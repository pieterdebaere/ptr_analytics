import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LINKS } from '~/config';
import { GitHubIcon } from './GitHubIcon';
import { LinkButton } from './LinkButton';
import { Logo } from './Logo';
import { Container } from './Section';
import { ThemeToggle } from './ThemeToggle';

export const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#self-host', label: 'Self-host' },
  { href: '#faq', label: 'FAQ' },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onResize = () => window.innerWidth >= 768 && setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    <header
      id="top"
      className={cn(
        'sticky top-0 z-50 w-full border-b transition-colors duration-200',
        scrolled || open ? 'border-border bg-background/80 backdrop-blur-xl' : 'border-transparent bg-transparent',
      )}
    >
      <Container className="flex h-16 items-center justify-between gap-4">
        <a href="#top" className="rounded-md" aria-label="PTR Analytics — back to top">
          <Logo />
        </a>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <a
                  href={item.href}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-1.5">
          <LinkButton
            href={LINKS.repo}
            external
            variant="ghost"
            className="hidden size-9 px-0 text-muted-foreground hover:text-foreground sm:inline-flex"
            aria-label="PTR Analytics on GitHub"
            title="GitHub"
          >
            <GitHubIcon />
          </LinkButton>
          <ThemeToggle />
          <LinkButton href={LINKS.login} variant="ghost" className="hidden md:inline-flex">
            Log in
          </LinkButton>
          <LinkButton href={LINKS.signup} className="hidden sm:inline-flex">
            Start for free
          </LinkButton>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X /> : <Menu />}
          </Button>
        </div>
      </Container>

      {open ? (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t md:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-2 py-2.5 text-base text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
            <a
              href={LINKS.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md px-2 py-2.5 text-base text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <GitHubIcon /> GitHub
            </a>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <LinkButton href={LINKS.login} variant="outline" size="lg">
                Log in
              </LinkButton>
              <LinkButton href={LINKS.signup} size="lg">
                Start for free
              </LinkButton>
            </div>
          </Container>
        </nav>
      ) : null}
    </header>
  );
}
