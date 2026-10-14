import { Code2, LayoutDashboard, Server } from 'lucide-react';
import { APP_URL } from '~/config';
import { Container, Section, SectionHeading } from '~/components/Section';

const STEPS = [
  {
    icon: Code2,
    title: 'Add one line',
    text: 'Paste the script tag into the <head> of your site. Works with any framework, CMS or static site — single-page apps included.',
    code: `<script defer src="${APP_URL.replace(/^https?:\/\//, '')}/script.js" …>`,
  },
  {
    icon: Server,
    title: 'The server anonymises',
    text: 'Each page view and web vital is checked, the IP address is used once for a salted daily hash and a country lookup, then discarded.',
    code: 'sha256(salt || site || ip || ua)',
  },
  {
    icon: LayoutDashboard,
    title: 'Insights in one dashboard',
    text: 'Visitors, sources, events and Core Web Vitals for all your websites, in a single fast dashboard with CSV export.',
    code: 'visitors ▲ 18%  ·  LCP 1.8 s',
  },
] as const;

export function HowItWorks() {
  return (
    <Section id="how-it-works" labelledBy="how-title" className="border-t bg-surface/40">
      <Container className="flex flex-col gap-14">
        <SectionHeading
          id="how-title"
          eyebrow="How it works"
          title="Script → server → dashboard"
          description="No SDKs, no build plugins, no tag manager. A ~3 KB script sends anonymous events to one server that powers the dashboard for all your sites."
        />
        <div className="relative">
        <div
          className="pointer-events-none absolute top-[2.9rem] right-[10%] left-[10%] hidden h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent md:block"
          aria-hidden="true"
        />
        <ol className="relative grid grid-cols-1 gap-4 md:grid-cols-3">
          {STEPS.map(({ icon: Icon, title, text, code }, i) => (
            <li key={title} className="relative flex flex-col gap-4 rounded-xl border bg-card p-6 card-sheen">
              <div className="flex items-center justify-between">
                <span className="flex size-11 items-center justify-center rounded-xl border bg-background text-brand shadow-sm">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">0{i + 1}</span>
              </div>
              <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
              <code className="mt-auto truncate rounded-lg border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">{code}</code>
            </li>
          ))}
        </ol>
        </div>
      </Container>
    </Section>
  );
}
