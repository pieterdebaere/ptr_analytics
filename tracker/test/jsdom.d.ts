// Minimal typings for jsdom (no @types/jsdom installed; only what the tests use).
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    referrer?: string;
    runScripts?: 'dangerously' | 'outside-only';
    pretendToBeVisual?: boolean;
  }
  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
  }
}
