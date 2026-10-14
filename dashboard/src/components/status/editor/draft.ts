// Editable part of a status page (saved with one PATCH) and its validation.
import { slugError, type StatusPage, type StatusPageInput, type StatusSection, type StatusTheme } from '@/api/status';

export const TITLE_MAX = 100;
export const MARKDOWN_MAX = 5000;
export const SECTION_NAME_MAX = 100;
export const DISPLAY_NAME_MAX = 100;

export interface Draft {
  title: string;
  slug: string;
  description: string;
  footer: string;
  theme: StatusTheme;
  accent: string | null;
  published: boolean;
  noindex: boolean;
  showTags: boolean;
  showCertExpiry: boolean;
  showPoweredBy: boolean;
  refreshS: number;
  analyticsSiteId: string | null;
  sections: StatusSection[];
}

export function draftOf(p: StatusPage): Draft {
  return {
    title: p.title,
    slug: p.slug,
    description: p.description,
    footer: p.footer,
    theme: p.theme,
    accent: p.accent,
    published: p.published,
    noindex: p.noindex,
    showTags: p.showTags,
    showCertExpiry: p.showCertExpiry,
    showPoweredBy: p.showPoweredBy,
    refreshS: p.refreshS,
    analyticsSiteId: p.analyticsSiteId,
    sections: p.sections.map((s) => ({ name: s.name, monitors: s.monitors.map((m) => ({ ...m })) })),
  };
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function draftToInput(d: Draft): StatusPageInput {
  return {
    title: d.title.trim(),
    slug: d.slug,
    description: d.description,
    footer: d.footer,
    theme: d.theme,
    accent: d.accent,
    published: d.published,
    noindex: d.noindex,
    showTags: d.showTags,
    showCertExpiry: d.showCertExpiry,
    showPoweredBy: d.showPoweredBy,
    refreshS: d.refreshS,
    analyticsSiteId: d.analyticsSiteId,
    sections: d.sections.map((s) => ({
      name: s.name.trim(),
      monitors: s.monitors.map((m) => ({ uid: m.uid, displayName: m.displayName?.trim() ? m.displayName.trim() : null, showUrl: m.showUrl })),
    })),
  };
}

export type DraftErrors = Partial<Record<'title' | 'slug' | 'description' | 'footer' | 'sections', string>>;

export function validateDraft(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  const title = d.title.trim();
  if (!title) e.title = 'Enter a title.';
  else if (title.length > TITLE_MAX) e.title = `At most ${TITLE_MAX} characters.`;
  const se = slugError(d.slug);
  if (se) e.slug = se;
  if (d.description.length > MARKDOWN_MAX) e.description = `At most ${MARKDOWN_MAX} characters.`;
  if (d.footer.length > MARKDOWN_MAX) e.footer = `At most ${MARKDOWN_MAX} characters.`;
  const badSection = d.sections.findIndex((s) => !s.name.trim() || s.name.trim().length > SECTION_NAME_MAX);
  if (badSection >= 0) e.sections = `Group ${badSection + 1} needs a name (at most ${SECTION_NAME_MAX} characters).`;
  else if (d.sections.some((s) => s.monitors.some((m) => (m.displayName ?? '').trim().length > DISPLAY_NAME_MAX))) {
    e.sections = `Display names can have at most ${DISPLAY_NAME_MAX} characters.`;
  }
  return e;
}

/** Moves item `i` of `list` by `delta` (returns a new array). */
export function move<T>(list: readonly T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (j < 0 || j >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(i, 1);
  next.splice(j, 0, item as T);
  return next;
}
