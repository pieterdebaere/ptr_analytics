import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { CONTACT_EMAIL, LINKS, PRICING } from '~/config';
import { formatPrice } from '~/lib/pricing';
import { Container, Section, SectionHeading } from '~/components/Section';

function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http');
  return (
    <a
      href={href}
      className="text-foreground underline underline-offset-4 hover:text-brand"
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

const contact = CONTACT_EMAIL ? <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A> : <A href={LINKS.issues}>open an issue</A>;

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: 'Do I need a cookie banner? Is it GDPR-friendly?',
    a: (
      <>
        PTR Analytics sets no cookies, uses no local storage and stores no IP addresses or other identifiers that can single
        out a person — visitor hashes are salted with a random value that is deleted every day. That's why, in most cases, no
        consent banner is needed for it. Laws differ per country, so always check your own legal requirements.
      </>
    ),
  },
  {
    q: 'Who owns my data?',
    a: (
      <>
        You do. Self-hosted, the data never leaves your server. On the hosted service we only process it to show you your
        dashboard — we never sell or share it, you can export it as CSV at any time, and deleting your account deletes all
        your websites and their data.
      </>
    ),
  },
  {
    q: 'What happens if I stop paying?',
    a: (
      <>
        Your first website keeps working for free. Additional websites are paused: their new page views are no longer recorded
        and the dashboard shows a notice. Nothing is deleted — pick a plan again and they continue where they left off.
      </>
    ),
  },
  {
    q: 'Can I switch between hosted and self-hosted?',
    a: (
      <>
        Yes. Both run exactly the same open-source software, so there's no lock-in. Switching is a matter of changing the
        script URL in your &lt;head&gt;. You can export your data as CSV at any time; if you'd like help moving historic data
        between servers, {contact}.
      </>
    ),
  },
  {
    q: 'What is the license?',
    a: (
      <>
        PTR Analytics is open source under the <A href={LINKS.license}>MIT license</A>. Use it commercially, modify it, host it
        for your clients — free of charge. The source of the hosted service is the same code you find on{' '}
        <A href={LINKS.repo}>GitHub</A>.
      </>
    ),
  },
  {
    q: 'Will the script slow down my website?',
    a: (
      <>
        No. It's about 5 KB (~3 KB gzipped), loads with <code className="font-mono text-[0.9em]">defer</code>, has no
        dependencies and sends small beacons in the background. It measures Core Web Vitals without affecting them.
      </>
    ),
  },
  {
    q: 'How is this different from Vercel Web Analytics?',
    a: (
      <>
        It works on any host — Vercel, Netlify, your own server or a WordPress site — and shows all your websites in one
        dashboard. It's open source, you can self-host it, and the hosted plan is a flat {formatPrice(PRICING.pricePerSiteCents, PRICING.currency)} per extra website instead of
        event-based pricing.
      </>
    ),
  },
];

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-title" className="border-t">
      <Container className="grid grid-cols-1 gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <SectionHeading
          id="faq-title"
          align="left"
          eyebrow="FAQ"
          title="Questions & answers"
          description={<>Something else on your mind? {CONTACT_EMAIL ? <>Mail {contact}</> : <>Just {contact} on GitHub</>}.</>}
          className="lg:sticky lg:top-24 lg:self-start"
        />
        <div className="flex flex-col divide-y rounded-2xl border bg-card">
          {FAQ.map((item, i) => (
            <details key={item.q} className="faq-item group" open={i === 0}>
              <summary className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left font-medium transition-colors hover:text-brand sm:px-6 sm:py-5">
                {item.q}
                <ChevronDown className="faq-chevron size-4 shrink-0 text-muted-foreground transition-transform duration-200" aria-hidden="true" />
              </summary>
              <div className="-mt-1 px-5 pb-5 text-sm leading-relaxed text-muted-foreground sm:px-6">{item.a}</div>
            </details>
          ))}
        </div>
      </Container>
    </Section>
  );
}
