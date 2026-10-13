/**
 * Default values for the build-time configuration. Kept free of `import.meta.env`
 * so that `vite.config.ts` (Node) can import it too. Override with `VITE_*`
 * environment variables at build time — see landing/README.md.
 */
export const CONFIG_DEFAULTS = {
  /** The hosted analytics server (dashboard, sign-up, log-in). */
  appUrl: 'https://analytics.pieterdebaere.be',
  /** The public GitHub repository. */
  repoUrl: 'https://github.com/pieterdebaere/ptr_analytics',
  /**
   * Public URL of this landing page, e.g. `https://ptr-analytics.example.com`; used for the
   * canonical link and the absolute Open Graph URLs. Empty = those tags are left out.
   */
  siteUrl: '',
  /** Optional contact address shown in the footer and FAQ (empty = hidden). */
  contactEmail: '',
} as const;
