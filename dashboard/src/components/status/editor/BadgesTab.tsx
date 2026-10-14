// Embeddable status badge + RSS feed of a status page.
import { useState } from 'react';
import { RssIcon } from 'lucide-react';
import { statusUrls, type StatusPage } from '@/api/status';
import { CodeBlock } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export const BADGE_STYLES = ['flat', 'flat-square', 'for-the-badge'] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

export function badgeSnippets(origin: string, page: Pick<StatusPage, 'slug' | 'title'>, style: BadgeStyle) {
  const urls = statusUrls(origin, page.slug);
  const img = style === 'flat' ? urls.badge : `${urls.badge}?style=${style}`;
  const alt = 'Status';
  return {
    url: img,
    markdown: `[![${alt}](${img})](${urls.page})`,
    html: `<a href="${urls.page}"><img src="${img}" alt="${alt}"></a>`,
    rss: urls.rss,
  };
}

export function BadgesTab({ page, origin }: { page: StatusPage; origin: string }) {
  const [style, setStyle] = useState<BadgeStyle>('flat');
  const s = badgeSnippets(origin, page, style);
  // Same-origin path for the live preview (CSP img-src 'self').
  const previewSrc = `/api/public/status/${encodeURIComponent(page.slug)}/badge.svg${style === 'flat' ? '' : `?style=${style}`}`;

  return (
    <div className="flex flex-col gap-6">
      {!page.published ? (
        <p className="rounded-lg border border-warn/40 bg-warn/[0.08] px-3 py-2 text-sm">Badges and the feed work once the page is published (General → Published).</p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Status badge</CardTitle>
          <CardDescription>Shows the overall status of this page — for READMEs, docs and footers.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <ToggleGroup
              value={[style]}
              onValueChange={(v: unknown[]) => {
                const next = v[0];
                if ((BADGE_STYLES as readonly unknown[]).includes(next)) setStyle(next as BadgeStyle);
              }}
              variant="outline"
              spacing={0}
              aria-label="Badge style"
            >
              {BADGE_STYLES.map((b) => (
                <ToggleGroupItem key={b} value={b}>
                  {b}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <span className="flex h-8 items-center rounded-lg border border-dashed px-3" data-slot="badge-preview">
              {page.published ? <img src={previewSrc} alt="Status badge preview" className="h-5" /> : <span className="text-xs text-muted-foreground">Preview after publishing</span>}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Markdown</span>
            <CodeBlock code={s.markdown} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">HTML</span>
            <CodeBlock code={s.html} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Image URL</span>
            <CodeBlock code={s.url} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RssIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            RSS feed
          </CardTitle>
          <CardDescription>Incidents and outages for feed readers and chat integrations.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={s.rss} />
        </CardContent>
      </Card>
    </div>
  );
}
