// One-shot, in-memory hand-over of a freshly created push URL from the edit page to the
// detail page. Never persisted (no history state, no storage) and never logged.
const pending = new Map<string, string>();

export function rememberPushUrl(uid: string, url: string): void {
  pending.set(uid, url);
}

export function takePushUrl(uid: string): string | null {
  const url = pending.get(uid) ?? null;
  pending.delete(uid);
  return url;
}

/** Only http(s) URLs are shown as push URLs. */
export function isSafePushUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The URL with its last path segment (the token) masked, for display. */
export function maskPushUrl(url: string): string {
  const i = url.lastIndexOf('/');
  if (i < 0) return '••••••••';
  const token = url.slice(i + 1).split('?')[0] ?? '';
  return `${url.slice(0, i + 1)}${token.slice(0, 3)}${'•'.repeat(Math.max(6, Math.min(16, token.length - 3)))}`;
}

export type PushExampleLang = 'curl' | 'curl-header' | 'cron' | 'powershell' | 'node' | 'python';

export const PUSH_EXAMPLE_LANGS: Array<{ key: PushExampleLang; label: string }> = [
  { key: 'curl', label: 'curl' },
  { key: 'curl-header', label: 'curl (header)' },
  { key: 'cron', label: 'cron' },
  { key: 'powershell', label: 'PowerShell' },
  { key: 'node', label: 'Node.js' },
  { key: 'python', label: 'Python' },
];

/**
 * ".../api/push/<token>" -> { endpoint: ".../api/push", token } for the header variant
 * (`X-Push-Token`, keeps the token out of access logs). Placeholders for anything else.
 */
export function splitPushUrl(url: string): { endpoint: string; token: string } {
  const i = url.lastIndexOf('/');
  if (i < 0 || !/\/api\/push$/.test(url.slice(0, i))) return { endpoint: '<BASE_URL>/api/push', token: '<PUSH_TOKEN>' };
  return { endpoint: url.slice(0, i), token: url.slice(i + 1).split('?')[0] || '<PUSH_TOKEN>' };
}

/** Example snippets calling the push URL (the URL is inserted verbatim, quoted). */
export function pushExample(lang: PushExampleLang, url: string, intervalS: number): string {
  const full = `${url}?status=up&msg=OK&ping=`;
  const everyMin = Math.max(1, Math.round(intervalS / 60));
  switch (lang) {
    case 'curl':
      return `curl -fsS -m 10 --retry 3 "${full}"`;
    case 'curl-header': {
      const { endpoint, token } = splitPushUrl(url);
      return `curl -fsS -m 10 --retry 3 -H "X-Push-Token: ${token}" "${endpoint}?status=up&msg=OK&ping="`;
    }
    case 'cron':
      return `*/${everyMin} * * * * curl -fsS -m 10 --retry 3 "${full}" > /dev/null`;
    case 'powershell':
      return `Invoke-RestMethod -Uri "${full}" -TimeoutSec 10`;
    case 'node':
      return `await fetch(${JSON.stringify(full)}, { signal: AbortSignal.timeout(10_000) });`;
    case 'python':
      return `import urllib.request\nurllib.request.urlopen(${JSON.stringify(full)}, timeout=10)`;
  }
}
