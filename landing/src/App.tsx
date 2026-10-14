import { SiteHeader } from '~/components/SiteHeader';
import { Faq } from '~/sections/Faq';
import { Features } from '~/sections/Features';
import { FinalCta } from '~/sections/FinalCta';
import { Footer } from '~/sections/Footer';
import { Hero } from '~/sections/Hero';
import { HowItWorks } from '~/sections/HowItWorks';
import { Pricing } from '~/sections/Pricing';
import { Privacy } from '~/sections/Privacy';
import { Security } from '~/sections/Security';
import { SelfHost } from '~/sections/SelfHost';
import { Stats } from '~/sections/Stats';

export function App() {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-[100] rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <Stats />
        <Features />
        <HowItWorks />
        <Privacy />
        <Security />
        <Pricing />
        <SelfHost />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
