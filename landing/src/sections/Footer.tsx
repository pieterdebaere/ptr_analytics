import { CONTACT_EMAIL, LINKS } from '~/config';
import { GitHubIcon } from '~/components/GitHubIcon';
import { Logo } from '~/components/Logo';
import { Container } from '~/components/Section';
import { ThemeToggle } from '~/components/ThemeToggle';

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'Privacy', href: '#privacy' },
      { label: 'Security', href: '#security' },
      { label: 'Pricing', href: '#pricing' },
      { label: 'FAQ', href: '#faq' },
    ],
  },
  {
    title: 'Open source',
    links: [
      { label: 'GitHub', href: LINKS.repo, external: true },
      { label: 'Documentation', href: LINKS.readme, external: true },
      { label: 'Tracking script', href: LINKS.tracker, external: true },
      { label: 'Security policy', href: LINKS.security, external: true },
      { label: 'MIT license', href: LINKS.license, external: true },
    ],
  },
  {
    title: 'Hosted',
    links: [
      { label: 'Start for free', href: LINKS.signup },
      { label: 'Log in', href: LINKS.login },
      // TODO: replace the '#' placeholders in config.ts (LINKS.privacy / LINKS.terms / LINKS.imprint).
      { label: 'Privacy policy', href: LINKS.privacy },
      { label: 'Terms of service', href: LINKS.terms },
      ...(CONTACT_EMAIL ? [{ label: 'Contact', href: `mailto:${CONTACT_EMAIL}` }] : []),
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t bg-surface/40">
      <Container className="flex flex-col gap-12 py-14">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 flex flex-col gap-4 md:col-span-1">
            <a href="#top" className="w-fit rounded-md" aria-label="PTR Analytics — back to top">
              <Logo />
            </a>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              Privacy-friendly, open-source web analytics and speed insights for all your websites.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.title} aria-label={col.title} className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">{col.title}</h2>
              <ul className="flex flex-col gap-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground"
                      {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <div className="flex flex-col-reverse items-start justify-between gap-4 border-t pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} PTR Analytics · MIT licensed · This site uses no cookies.
          </p>
          <div className="flex items-center gap-1">
            <a
              href={LINKS.repo}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <GitHubIcon />
            </a>
            <ThemeToggle />
          </div>
        </div>
      </Container>
    </footer>
  );
}
