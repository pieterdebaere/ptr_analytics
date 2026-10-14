import { ArrowRight } from 'lucide-react';
import { LINKS } from '~/config';
import { GitHubIcon } from '~/components/GitHubIcon';
import { LinkButton } from '~/components/LinkButton';
import { Container } from '~/components/Section';

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="border-t py-20 sm:py-28">
      <Container>
        <div className="relative isolate overflow-hidden rounded-3xl border bg-card px-6 py-14 text-center sm:px-12 sm:py-20">
          <div className="pointer-events-none absolute inset-0 -z-10 bg-grid mask-fade-radial opacity-80" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-0 -z-10 bg-section-glow" aria-hidden="true" />
          <h2 id="cta-title" className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            <span className="text-gradient">Know your visitors. Not who they are.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
            Add your first website in a minute — it's free. Or run the whole thing on your own server.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <LinkButton href={LINKS.signup} size="lg">
              Start for free
              <ArrowRight />
            </LinkButton>
            <LinkButton href={LINKS.repo} external size="lg" variant="outline">
              <GitHubIcon />
              Self-host on GitHub
            </LinkButton>
          </div>
        </div>
      </Container>
    </section>
  );
}
