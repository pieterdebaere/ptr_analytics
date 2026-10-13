/**
 * Tiny dependency-free user agent parser and bot detector. It intentionally only knows
 * the major browsers / operating systems; everything else is reported as null (unknown).
 */

export type Device = 'mobile' | 'tablet' | 'desktop';

export interface ParsedUA {
  browser: string | null;
  os: string | null;
  device: Device | null;
}

const MAX_UA = 1024;

const BOT_RE = new RegExp(
  [
    'bot\\b',
    'bot/',
    'bot;',
    'robot',
    'crawl',
    'spider',
    'slurp',
    'headless',
    'lighthouse',
    'preview',
    'facebookexternalhit',
    'facebookcatalog',
    'curl/',
    'wget',
    'python-requests',
    'python-urllib',
    'python/',
    'aiohttp',
    'httpx',
    'go-http-client',
    'java/',
    'okhttp',
    'axios',
    'node-fetch',
    'undici',
    'libwww',
    'httpclient',
    'scrapy',
    'phantomjs',
    'selenium',
    'puppeteer',
    'playwright',
    'cypress',
    'pingdom',
    'uptimerobot',
    'statuscake',
    'site24x7',
    'gtmetrix',
    'pagespeed',
    'ia_archiver',
    'archive\\.org',
    'semrush',
    'ahrefs',
    'mj12',
    'yandex(?:bot|images|metrika)',
    'baiduspider',
    'bingpreview',
    'mediapartners',
    'feedfetcher',
    'google-inspectiontool',
    'googleother',
    'whatsapp',
    'telegrambot',
    'discordbot',
    'slackbot',
    'embedly',
    'quora link preview',
    'vercelbot',
    'datadog',
    'newrelic',
  ].join('|'),
  'i',
);

/** True for known bots, automation tools, link previewers and empty user agents. */
export function isBot(ua: string | undefined): boolean {
  if (ua === undefined) return true;
  const s = ua.trim();
  if (s.length < 5) return true;
  return BOT_RE.test(s.slice(0, MAX_UA));
}

const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera|OPiOS|OPT)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bUCBrowser\//, 'UC Browser'],
  [/\bDuckDuckGo\/|\bDdg\//, 'DuckDuckGo'],
  [/\bFBAN\/|\bFBAV\//, 'Facebook'],
  [/\bInstagram\b/, 'Instagram'],
  [/\b(?:MSIE |Trident\/)/, 'Internet Explorer'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrom(?:e|ium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/\b(?:iPhone|iPad|iPod)\b.*AppleWebKit/, 'Safari'],
];

const OSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bWindows Phone\b/, 'Windows Phone'],
  [/\bWindows\b/, 'Windows'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bHarmonyOS\b/, 'HarmonyOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'Chrome OS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bFreeBSD\b/, 'FreeBSD'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

const TABLET_RE = /\biPad\b|\bTablet\b|\bPlayBook\b|\bSilk\/|\bKindle\b|\bAndroid(?!.*\bMobile\b)/i;
const MOBILE_RE = /\bMobi|\biPhone\b|\biPod\b|\bWindows Phone\b|\bIEMobile\b|\bBlackBerry\b|\bOpera Mini\b/i;
const DESKTOP_RE = /\bWindows NT\b|\bMacintosh\b|\bX11\b|\bCrOS\b|\bLinux x86_64\b/;

function first(list: ReadonlyArray<readonly [RegExp, string]>, ua: string): string | null {
  for (const [re, name] of list) if (re.test(ua)) return name;
  return null;
}

export function deviceFromWidth(width: number | undefined): Device | null {
  if (width === undefined || width <= 0) return null;
  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

export function parseUserAgent(uaRaw: string | undefined, width?: number): ParsedUA {
  const ua = (uaRaw ?? '').slice(0, MAX_UA);
  let device: Device | null = null;
  if (TABLET_RE.test(ua)) device = 'tablet';
  else if (MOBILE_RE.test(ua)) device = 'mobile';
  else if (DESKTOP_RE.test(ua)) device = 'desktop';
  else device = deviceFromWidth(width);
  return { browser: first(BROWSERS, ua), os: first(OSES, ua), device };
}
