import {
  FileDown,
  Gauge,
  Layers,
  MapPin,
  Megaphone,
  MonitorSmartphone,
  MousePointerClick,
  Route,
  Users,
} from 'lucide-react';
import { lazy, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { LazyMount } from '~/components/LazyMount';
import { Container, Section, SectionHeading } from '~/components/Section';
import { sum, visitorSeries } from '~/demos/data';

const load = () => import('~/demos/charts');
const VisitorsChart = lazy(() => load().then((m) => ({ default: m.VisitorsChart })));
const VitalsChart = lazy(() => load().then((m) => ({ default: m.VitalsChart })));
const TopPagesChart = lazy(() => load().then((m) => ({ default: m.TopPagesChart })));
const LiveChart = lazy(() => load().then((m) => ({ default: m.LiveChart })));
const DevicesChart = lazy(() => load().then((m) => ({ default: m.DevicesChart })));

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function DemoCard({
  title,
  description,
  badge,
  className,
  contentClassName,
  children,
}: {
  title: string;
  description: string;
  badge?: ReactNode;
  className?: string;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn('card-sheen gap-5 py-5 [--card-spacing:--spacing(5)] sm:py-6 sm:[--card-spacing:--spacing(6)]', className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">
            <h3>{title}</h3>
          </CardTitle>
          {badge}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className={cn('flex flex-1 flex-col justify-between gap-4', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

function Stat({ label, value, delta, invert }: { label: string; value: string; delta: string; invert?: boolean }) {
  const positive = delta.startsWith('+') !== Boolean(invert);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        <span className={cn('text-xs font-medium tabular-nums', positive ? 'text-good' : 'text-poor')}>{delta}</span>
      </span>
    </div>
  );
}

const MORE = [
  { icon: MousePointerClick, title: 'Custom events', text: "pa.track('Signup', { plan: 'pro' }) or a data attribute — no code needed." },
  { icon: Megaphone, title: 'Referrers & UTM', text: 'See which sources and campaigns bring visitors: source, medium, campaign, term, content.' },
  { icon: MapPin, title: 'Countries', text: 'Country-level location from a local GeoIP database. Never more precise than that.' },
  { icon: MonitorSmartphone, title: 'Devices & browsers', text: 'Device type, browser and operating system for every page and event.' },
  { icon: Layers, title: 'All sites, one dashboard', text: 'A central overview of every website with sparklines and trends at a glance.' },
  { icon: Route, title: 'SPA support', text: 'Client-side navigations via the History API are tracked automatically.' },
  { icon: FileDown, title: 'CSV export', text: 'Export any view with its filters. Your data, in a format you can take anywhere.' },
  { icon: Users, title: 'Teams', text: 'Invite colleagues as admin or read-only viewer. Click-to-filter, linkable URLs.' },
] as const;

export function Features() {
  const series = visitorSeries(30);
  const visitors = sum(series, 'visitors');
  const pageviews = sum(series, 'pageviews');

  return (
    <Section id="features" labelledBy="features-title">
      <Container className="flex flex-col gap-14">
        <SectionHeading
          id="features-title"
          eyebrow="Features"
          title="Web Analytics and Speed Insights. One script."
          description="Everything you'd expect from Vercel Web Analytics and Speed Insights — for every website you run, on any host, in one dashboard."
        />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <DemoCard
            className="lg:col-span-2"
            title="Visitors & page views"
            description="Trends with comparison to the previous period, time-zone aware."
            badge={<Badge variant="secondary">Last 30 days</Badge>}
          >
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Visitors" value={compact.format(visitors)} delta="+18.2%" />
              <Stat label="Page views" value={compact.format(pageviews)} delta="+21.4%" />
              <Stat label="Bounce rate" value="38%" delta="−4.1%" invert />
            </div>
            <LazyMount className="aspect-[2.4/1] min-h-[190px]">
              <VisitorsChart />
            </LazyMount>
          </DemoCard>

          <DemoCard
            title="Speed Insights"
            description="Core Web Vitals from real users (p75) and a Real Experience Score."
            badge={
              <Badge variant="outline" className="gap-1">
                <Gauge /> p75
              </Badge>
            }
          >
            <LazyMount className="min-h-[360px]">
              <VitalsChart />
            </LazyMount>
          </DemoCard>

          <DemoCard
            title="Live visitors"
            description="Who's on your sites right now, updated in real time."
            badge={
              <Badge variant="outline" className="gap-1.5">
                <span className="relative flex size-1.5" aria-hidden="true">
                  <span className="live-ping absolute inline-flex size-full rounded-full bg-good" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-good" />
                </span>
                Live
              </Badge>
            }
          >
            <LazyMount className="min-h-[215px]">
              <LiveChart />
            </LazyMount>
          </DemoCard>

          <DemoCard title="Top pages" description="Paths only — query strings and fragments are dropped." badge={<Badge variant="secondary">Page views</Badge>}>
            <LazyMount className="aspect-[1.35/1]">
              <TopPagesChart />
            </LazyMount>
          </DemoCard>

          <DemoCard contentClassName="justify-center" title="Devices" description="Desktop, mobile or tablet — plus browsers and OS." badge={<Badge variant="secondary">Visitors</Badge>}>
            <LazyMount className="min-h-[148px]">
              <DevicesChart />
            </LazyMount>
          </DemoCard>
        </div>

        <p className="-mt-10 text-center text-xs text-muted-foreground">Charts show demo data, rendered with the same Bklit chart components as the dashboard.</p>

        <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:gap-x-8 lg:grid-cols-4">
          {MORE.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex flex-col gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg border bg-surface text-brand">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <h3 className="mt-1 font-medium">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </Section>
  );
}
