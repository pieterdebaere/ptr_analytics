import { SiteLiveView } from '@/components/live';
import { useSite } from './SiteLayout';

/** /sites/:id/live — globe, live counter, visitors line and recent pageviews. */
export function SiteLivePage() {
  const { site } = useSite();
  return <SiteLiveView key={site.id} siteId={site.id} />;
}
