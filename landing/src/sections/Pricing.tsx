import { ArrowRight, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { LINKS, PRICING } from '~/config';
import { GitHubIcon } from '~/components/GitHubIcon';
import { LinkButton } from '~/components/LinkButton';
import { Container, Section, SectionHeading } from '~/components/Section';
import { formatPrice } from '~/lib/pricing';
import { PriceCalculator } from './PriceCalculator';

const unit = formatPrice(PRICING.pricePerSiteCents, PRICING.currency);

function Feature({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function Yes({ label = 'Included' }: { label?: string }) {
  return (
    <>
      <Check className="size-4 text-good" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </>
  );
}

type Cell = ReactNode | true;

const COMPARISON: { label: string; self: Cell; hosted: Cell }[] = [
  { label: 'Web Analytics & Speed Insights', self: true, hosted: true },
  { label: 'Custom events, UTM, CSV export', self: true, hosted: true },
  { label: 'No cookies, no IPs stored', self: true, hosted: true },
  { label: 'Live visitors & 3D globe', self: true, hosted: true },
  { label: 'Websites', self: 'Unlimited', hosted: `1 free, then ${unit}/mo each` },
  { label: 'Server & updates', self: 'You', hosted: 'We do it' },
  { label: 'Backups', self: 'You', hosted: 'We do it' },
  { label: 'TLS certificates', self: 'You (e.g. Caddy)', hosted: 'We do it' },
  { label: 'GeoIP database updates', self: 'Automatic (opt-in)', hosted: 'We do it' },
  { label: 'Where your data lives', self: 'Your server', hosted: 'Our server' },
  { label: 'Price', self: 'Free forever', hosted: `From ${formatPrice(0)}` },
];

function renderCell(c: Cell) {
  if (c === true) return <Yes />;
  return <span>{c}</span>;
}

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-title" className="border-t">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-section-glow" aria-hidden="true" />
      <Container className="flex flex-col gap-12">
        <SectionHeading
          id="pricing-title"
          eyebrow="Pricing"
          title="Two ways to use it. Both honest."
          description="Run it yourself for free, forever — or let us run it for you. Same open-source software, same features."
        />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="gap-6 py-6 [--card-spacing:--spacing(6)] sm:py-8 sm:[--card-spacing:--spacing(8)]">
            <CardHeader className="gap-3">
              <div className="flex h-6 items-center justify-between gap-2">
                <CardTitle className="text-lg font-semibold">
                  <h3>Self-hosted</h3>
                </CardTitle>
                <Badge variant="outline">Open source</Badge>
              </div>
              <p className="flex items-baseline gap-2">
                <span className="text-4xl font-semibold tracking-tighter">{formatPrice(0)}</span>
                <span className="text-muted-foreground">forever</span>
              </p>
              <CardDescription>Run PTR Analytics on your own server with Docker. You own everything.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <ul className="flex flex-col gap-3">
                <Feature>All features, unlimited websites and users</Feature>
                <Feature>Your data never leaves your server</Feature>
                <Feature>One-command Docker deploy</Feature>
                <Feature>MIT license — fork it, change it</Feature>
                <Feature>Community support on GitHub</Feature>
              </ul>
            </CardContent>
            <CardFooter className="border-t-0 bg-transparent pt-0">
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <LinkButton href={LINKS.repo} external variant="outline" size="lg">
                  <GitHubIcon />
                  View on GitHub
                </LinkButton>
                <LinkButton href="#self-host" variant="ghost" size="lg">
                  Read the guide
                </LinkButton>
              </div>
            </CardFooter>
          </Card>

          <Card className="relative gap-6 py-6 ring-2 ring-brand/60 [--card-spacing:--spacing(6)] sm:py-8 sm:[--card-spacing:--spacing(8)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-brand/10 to-transparent" aria-hidden="true" />
            <CardHeader className="relative gap-3">
              <div className="flex h-6 items-center justify-between gap-2">
                <CardTitle className="text-lg font-semibold">
                  <h3>Hosted by us</h3>
                </CardTitle>
                <Badge className="bg-brand text-brand-foreground">No server needed</Badge>
              </div>
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-4xl font-semibold tracking-tighter">{formatPrice(0)}</span>
                <span className="text-muted-foreground">for your first website</span>
              </p>
              <CardDescription>
                Then {unit} per month for each additional website. Add or remove websites any time.
              </CardDescription>
            </CardHeader>
            <CardContent className="relative flex-1">
              <ul className="flex flex-col gap-3">
                <Feature>Exactly the same features as self-hosted</Feature>
                <Feature>We handle updates, backups, TLS and GeoIP</Feature>
                <Feature>Ready in a minute — sign up, add the script</Feature>
                <Feature>Stop paying any time: extra sites pause, nothing is deleted</Feature>
                <Feature>Export your raw data as CSV at any time</Feature>
              </ul>
            </CardContent>
            <CardFooter className="relative border-t-0 bg-transparent pt-0">
              <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                <LinkButton href={LINKS.signup} size="lg">
                  Start for free
                  <ArrowRight />
                </LinkButton>
                <LinkButton href={LINKS.login} variant="ghost" size="lg">
                  Log in
                </LinkButton>
              </div>
            </CardFooter>
          </Card>
        </div>

        <PriceCalculator />

        <div className="flex flex-col gap-4">
          <h3 className="text-center text-lg font-semibold tracking-tight">Self-hosted vs. hosted</h3>
          <div className="overflow-hidden rounded-2xl border bg-card">
            <Table className="table-fixed">
              <caption className="sr-only">Comparison of the self-hosted and the hosted version</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[40%] px-4 sm:px-6">
                    <span className="sr-only">Feature</span>
                  </TableHead>
                  <TableHead className="px-3 font-semibold text-foreground sm:px-6">Self-hosted</TableHead>
                  <TableHead className="px-3 font-semibold text-foreground sm:px-6">Hosted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {COMPARISON.map((row) => (
                  <TableRow key={row.label} className="hover:bg-muted/30">
                    <TableHead scope="row" className="h-auto px-4 py-3 font-normal whitespace-normal text-muted-foreground sm:px-6">
                      {row.label}
                    </TableHead>
                    {[row.self, row.hosted].map((c, i) => (
                      <TableCell key={i} className={cn('px-3 py-3 whitespace-normal sm:px-6', c === true && 'align-middle')}>
                        {renderCell(c)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            VAT may apply. Payments are handled by Stripe; cancel or change the number of websites any time.
          </p>
        </div>
      </Container>
    </Section>
  );
}
