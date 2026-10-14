import { CONFIG_DEFAULTS } from './config.defaults';

/** Remove trailing slashes so we can safely append paths. */
export function trimUrl(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim();
  const url = v.length > 0 ? v : fallback;
  return url.replace(/\/+$/, '');
}

const env = import.meta.env;

/** Hosted analytics server, e.g. `https://analytics.pieterdebaere.be` (VITE_APP_URL). */
export const APP_URL = trimUrl(env.VITE_APP_URL, CONFIG_DEFAULTS.appUrl);
/** GitHub repository (VITE_REPO_URL). */
export const REPO_URL = trimUrl(env.VITE_REPO_URL, CONFIG_DEFAULTS.repoUrl);
/** Public URL of the landing page itself (VITE_SITE_URL) — canonical / Open Graph. May be empty. */
export const SITE_URL = trimUrl(env.VITE_SITE_URL, CONFIG_DEFAULTS.siteUrl);
/** Optional contact e-mail address (VITE_CONTACT_EMAIL). Empty string = not shown. */
export const CONTACT_EMAIL = (env.VITE_CONTACT_EMAIL ?? CONFIG_DEFAULTS.contactEmail).trim();

/** Hosted-plan pricing (display only — Stripe is authoritative on the server). */
export const PRICING = {
  /** Websites included for free per hosted account (server: FREE_SITES). */
  freeSites: 1,
  /** Price per additional website per month, in cents (server: PRICE_PER_SITE_CENTS). */
  pricePerSiteCents: 100,
  currency: 'EUR',
} as const;

export const LINKS = {
  signup: `${APP_URL}/signup`,
  login: `${APP_URL}/login`,
  repo: REPO_URL,
  readme: `${REPO_URL}#readme`,
  docs: `${REPO_URL}/blob/main/docs/SPEC.md`,
  security: `${REPO_URL}/blob/main/SECURITY.md`,
  tracker: `${REPO_URL}/blob/main/tracker/README.md`,
  license: `${REPO_URL}/blob/main/LICENSE`,
  issues: `${REPO_URL}/issues`,
  // TODO: the hosted service has no public legal pages yet. Replace these
  // placeholders with the real URLs (e.g. `${APP_URL}/legal/privacy`) once they exist.
  privacy: '#',
  terms: '#',
  imprint: '#',
} as const;

/** The one-line install snippet as shown to hosted users. */
export const SCRIPT_SNIPPET = `<script defer src="${APP_URL}/script.js" data-site="YOUR_SITE_ID"></script>`;

/** Clone URL for `git clone`. */
export const CLONE_URL = REPO_URL.endsWith('.git') ? REPO_URL : `${REPO_URL}.git`;

/** Directory name `git clone` creates. */
export const REPO_DIR = (REPO_URL.split('/').pop() ?? 'ptr_analytics').replace(/\.git$/, '');
