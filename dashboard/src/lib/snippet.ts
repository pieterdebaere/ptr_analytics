// Install / usage snippets shown in the dashboard (rendered as plain text).

/** The origin that serves /script.js: config.publicUrl if valid, else the fallback. */
export function snippetOrigin(publicUrl: string | null | undefined, fallback: string): string {
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    } catch {
      /* invalid -> fallback */
    }
  }
  return fallback.replace(/\/+$/, '');
}

export function installSnippet(origin: string, siteId: string): string {
  return `<script defer src="${origin}/script.js" data-site="${siteId}"></script>`;
}

export const QUEUE_SNIPPET =
  '<script>window.pa=window.pa||function(){(window.pa.q=window.pa.q||[]).push(arguments)}</script>';

export const TRACK_EXAMPLE = "pa.track('Signup', { plan: 'pro' })";

export const QUEUE_TRACK_EXAMPLE = "pa('track', 'Signup', { plan: 'pro' })";

export const DECLARATIVE_EXAMPLE = '<button data-pa-event="Signup" data-pa-event-plan="pro">Sign up</button>';

export const IGNORE_SNIPPET = "localStorage.setItem('pa_ignore', 'true')";
