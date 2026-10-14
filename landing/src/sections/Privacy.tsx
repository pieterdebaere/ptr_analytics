import { Check, Cookie, EyeOff, Fingerprint, RefreshCw, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Container, Section, SectionHeading } from '~/components/Section';

const POINTS = [
  {
    icon: Cookie,
    title: 'No cookies, no banner',
    text: 'No cookies, no localStorage, no fingerprint stored. Nothing to consent to, so no cookie banner in front of your content.',
  },
  {
    icon: EyeOff,
    title: 'No IP addresses stored',
    text: 'The address is used in memory for an anonymous hash and a country lookup, then thrown away. Never written to disk or logs.',
  },
  {
    icon: RefreshCw,
    title: 'Daily-rotating salted hashes',
    text: 'Visitors are counted with a hash salted by a random value that is deleted at the end of each UTC day. Unlinkable across days.',
  },
  {
    icon: Fingerprint,
    title: 'Minimal data by design',
    text: 'Only the path is kept — no query strings (except UTM), no fragments, referrers reduced to a hostname. Respects opt-out, and optionally Do Not Track / GPC.',
  },
] as const;

const STORED = ['Page path (e.g. /pricing)', 'Referrer hostname', 'UTM parameters', 'Country', 'Browser, OS & device type', 'Web Vitals measurements'];
const NEVER = ['IP addresses', 'Cookies or local storage', 'Query strings & fragments', 'Cross-day or cross-site identifiers', 'User agents (raw)', 'Fingerprints or personal data'];

export function Privacy() {
  return (
    <Section id="privacy" labelledBy="privacy-title" grid>
      <Container className="grid grid-cols-1 items-start gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="flex flex-col gap-10">
          <SectionHeading
            id="privacy-title"
            align="left"
            eyebrow="Privacy"
            title="Respect your visitors. Skip the cookie banner."
            description="PTR Analytics is built so that you get useful numbers without tracking people. Counting visits, not individuals."
          />
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex flex-col gap-2">
                <span className="flex items-start gap-2 font-medium">
                  <Icon className="mt-1 size-4 shrink-0 text-brand" aria-hidden="true" />
                  {title}
                </span>
                <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
              </li>
            ))}
          </ul>
        </div>

        <Card className="gap-0 p-0 shadow-xl shadow-black/5 lg:mt-12 dark:shadow-black/40">
          <div className="grid grid-cols-1 sm:grid-cols-2">
            <div className="flex flex-col gap-4 p-6">
              <h3 className="text-sm font-medium">What is stored</h3>
              <ul className="flex flex-col gap-2.5">
                {STORED.map((s) => (
                  <li key={s} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <Check className="mt-0.5 size-4 shrink-0 text-good" aria-hidden="true" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col gap-4 border-t p-6 sm:border-t-0 sm:border-l">
              <h3 className="text-sm font-medium">What is never stored</h3>
              <ul className="flex flex-col gap-2.5">
                {NEVER.map((s) => (
                  <li key={s} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <X className="mt-0.5 size-4 shrink-0 text-poor" aria-hidden="true" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <Separator />
          <div className="flex flex-col gap-3 bg-surface/60 p-6">
            <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">How a visitor is counted</p>
            <div className="overflow-x-auto rounded-lg border bg-background px-4 py-3 font-mono text-xs leading-6 whitespace-nowrap">
              <span className="text-muted-foreground">id = </span>
              <span className="text-brand">sha256</span>(<span className="text-warn">daily_salt</span> || site || ip || user_agent)
              <span className="text-muted-foreground">[:16]</span>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The salt is 32 random bytes, generated per UTC day and securely deleted at midnight — after that, nobody (not even
              the server) can link or reverse yesterday's ids.
            </p>
          </div>
        </Card>
      </Container>
    </Section>
  );
}
