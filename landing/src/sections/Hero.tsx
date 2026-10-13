import { ArrowRight } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { APP_URL, LINKS, SCRIPT_SNIPPET } from '~/config';
import { CopyButton } from '~/components/CodeBlock';
import { GitHubIcon } from '~/components/GitHubIcon';
import { LinkButton } from '~/components/LinkButton';
import { Container } from '~/components/Section';

const HeroGlobe = lazy(() => import('~/demos/HeroGlobe'));

function GlobeFallback() {
  return (
    <div className="flex size-full items-center justify-center" aria-hidden="true">
      <div className="aspect-square w-[78%] animate-pulse rounded-full border bg-gradient-to-br from-muted/60 to-transparent" />
    </div>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-grid mask-fade-radial" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-hero-glow" aria-hidden="true" />

      <Container className="grid items-center gap-8 pt-14 pb-16 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:gap-6 lg:pt-20 lg:pb-24">
        <div className="flex min-w-0 flex-col items-start gap-6">
          <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="rounded-full">
            <Badge variant="outline" className="h-7 gap-2 rounded-full bg-background/60 px-3 text-xs backdrop-blur hover:bg-muted">
              <GitHubIcon className="size-3.5" />
              Open source · MIT licensed
              <ArrowRight className="text-muted-foreground" />
            </Badge>
          </a>

          <h1 id="hero-title" className="text-[2.5rem] leading-[1.04] font-semibold tracking-tighter sm:text-6xl lg:text-[3.4rem] xl:text-[3.75rem]">
            <span className="text-gradient">Analytics for all your websites.</span>{' '}
            <span className="text-brand sm:whitespace-nowrap">Without the cookies.</span>
          </h1>

          <p className="max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
            Privacy-friendly web analytics and Core Web Vitals in one central dashboard. An open-source alternative to
            Vercel Web Analytics and Speed Insights — no cookie banner, no IP addresses stored.
          </p>

          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <LinkButton href={LINKS.signup} size="lg" className="w-full sm:w-auto">
              Start for free
              <ArrowRight />
            </LinkButton>
            <LinkButton href={LINKS.repo} external size="lg" variant="outline" className="w-full sm:w-auto">
              <GitHubIcon />
              Self-host on GitHub
            </LinkButton>
          </div>
          <p className="-mt-2 text-sm text-muted-foreground">First website free · €1/month per extra site · or self-host free forever</p>

          <div className="w-full max-w-xl">
            <div className="flex items-center gap-2 rounded-xl border bg-surface/80 py-1.5 pr-1.5 pl-4 shadow-sm backdrop-blur">
              <span className="sr-only">Install snippet:</span>
              <code className="min-w-0 flex-1 overflow-x-auto py-1.5 font-mono text-[12.5px] whitespace-nowrap text-muted-foreground [mask-image:linear-gradient(to_right,#000_85%,transparent)] [scrollbar-width:none]">
                <span className="text-foreground/50">&lt;</span>
                <span className="text-brand">script</span> <span className="text-foreground/80">defer src</span>
                <span className="text-foreground/50">=</span>
                <span className="text-good">"{`${APP_URL}/script.js`}"</span>{' '}
                <span className="text-foreground/80">data-site</span>
                <span className="text-foreground/50">=</span>
                <span className="text-good">"YOUR_SITE_ID"</span>
                <span className="text-foreground/50">&gt;&lt;/</span>
                <span className="text-brand">script</span>
                <span className="text-foreground/50">&gt;</span>
              </code>
              <CopyButton text={SCRIPT_SNIPPET} label="Copy install snippet" />
            </div>
            <p className="mt-2 pl-1 text-xs text-muted-foreground">One line in your &lt;head&gt;. ~3 KB gzipped. That's the whole setup.</p>
          </div>
        </div>

        <div className="relative mx-auto aspect-square w-full max-w-[560px] lg:max-w-none">
          <div className="pointer-events-none absolute inset-[12%] -z-10 rounded-full bg-brand/15 blur-3xl" aria-hidden="true" />
          <Suspense fallback={<GlobeFallback />}>
            <HeroGlobe />
          </Suspense>
        </div>
      </Container>
    </section>
  );
}
