import { BadgeCheck, Database, KeyRound, Lock, Package, ShieldCheck, Timer, Waypoints } from 'lucide-react';
import { LINKS } from '~/config';
import { Container, Section, SectionHeading } from '~/components/Section';

const ITEMS = [
  { icon: ShieldCheck, title: 'Strict Content Security Policy', text: "script-src 'self', no inline scripts or styles, frame-ancestors 'none'." },
  { icon: Waypoints, title: 'CSRF protection', text: 'Every mutating request needs a custom header and a SameSite session cookie.' },
  { icon: KeyRound, title: 'scrypt password hashing', text: 'Memory-hard hashing with per-user salts; sessions are random, server-side tokens.' },
  { icon: Timer, title: 'Rate limiting', text: 'Login, sign-up and ingest are rate limited per IP address and per account or e-mail address.' },
  { icon: Database, title: 'Parameterised SQL', text: 'Every query is a prepared statement on SQLite (WAL, secure_delete).' },
  { icon: Package, title: 'Minimal dependencies', text: 'Small supply-chain surface; the tracker has zero runtime dependencies.' },
  { icon: Lock, title: 'Untrusted input everywhere', text: 'Paths, referrers and event names are validated, size-limited and escaped.' },
  { icon: BadgeCheck, title: 'Independently audited', text: 'Reviewed in multiple security audits, with a documented disclosure policy.' },
] as const;

export function Security() {
  return (
    <Section id="security" labelledBy="security-title" className="border-t">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-section-glow opacity-60" aria-hidden="true" />
      <Container className="flex flex-col gap-14">
        <SectionHeading
          id="security-title"
          eyebrow="Security"
          title="Hardened by default"
          description={
            <>
              Analytics touches every page you serve, so it must not become your weakest link. Read the{' '}
              <a href={LINKS.security} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-brand">
                security policy
              </a>
              .
            </>
          }
        />
        <ul className="grid grid-cols-1 overflow-hidden rounded-2xl border sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="-mt-px -ml-px flex flex-col gap-3 border-t border-l bg-card/60 p-6">
              <Icon className="size-5 text-brand" aria-hidden="true" />
              <h3 className="font-medium">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}
