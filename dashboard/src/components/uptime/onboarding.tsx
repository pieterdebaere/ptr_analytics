import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckIcon, GlobeIcon, PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import type { Site } from '@/api/types';
import { uptimeApi, type Monitor, type MonitorTypeInfo } from '@/api/uptime';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/useApi';
import { displayText, isSafeHostname } from '@/lib/safety';
import { toast } from './toast';

export interface Suggestion {
  siteId: string;
  siteName: string;
  domain: string;
  url: string;
}

/** "Monitor https://<domain>/" suggestions for the non-wildcard public domains of the sites. */
export function monitorSuggestions(sites: readonly Site[], existing: readonly Monitor[] = [], max = 4): Suggestion[] {
  const targets = new Set(existing.map((m) => (m.target ?? '').toLowerCase()));
  const out: Suggestion[] = [];
  for (const s of sites) {
    for (const raw of s.domains) {
      const d = raw.trim().toLowerCase().replace(/\.$/, '');
      if (!isSafeHostname(d)) continue; // skips wildcards, localhost, IPs
      const url = `https://${d}/`;
      if (targets.has(url) || targets.has(url.slice(0, -1))) continue;
      out.push({ siteId: s.id, siteName: s.name, domain: d, url });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Key of the URL field of the http type (from GET /api/uptime/types), default "url". */
export function urlFieldKey(type: MonitorTypeInfo | undefined): string {
  return type?.fields.find((f) => f.kind === 'url')?.key ?? 'url';
}

export function MonitorSuggestions({
  sites,
  existing,
  onCreated,
  max = 4,
}: {
  sites: readonly Site[];
  existing?: readonly Monitor[];
  onCreated: (m: Monitor) => void;
  max?: number;
}) {
  const types = useApi((signal) => uptimeApi.types(signal), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const list = monitorSuggestions(sites, existing, max);
  const http = types.data?.types.find((t) => t.type === 'http');
  const limits = types.data?.limits;
  if (list.length === 0) return null;
  const add = async (s: Suggestion) => {
    setBusy(s.url);
    try {
      const intervalS = Math.max(limits?.minIntervalS ?? 60, http?.defaults.intervalS ?? 60);
      const m = await uptimeApi.createMonitor(s.siteId, {
        type: 'http',
        name: s.domain,
        intervalS,
        retryIntervalS: intervalS,
        maxRetries: http?.defaults.retries ?? 1,
        timeoutMs: Math.min(limits?.maxTimeoutMs ?? 10_000, http?.defaults.timeoutMs ?? 10_000),
        certNotify: true,
        active: true,
        config: { [urlFieldKey(http)]: s.url },
      });
      setDone((d) => new Set(d).add(s.url));
      toast(`Now monitoring ${displayText(s.url)}`);
      onCreated(m);
    } catch (err) {
      toast(errorMessage(err) || 'Could not create the monitor.', 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <ul className="flex w-full max-w-xl flex-col gap-2 text-left">
      {list.map((s) => (
        <li key={s.url} className="flex items-center gap-3 rounded-xl border bg-background px-3 py-2.5 dark:bg-input/20">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-chart-1/10 text-chart-1" aria-hidden="true">
            <GlobeIcon className="size-4" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="bidi-isolate truncate text-sm font-medium text-foreground">Monitor {displayText(s.url)}</span>
            <span className="truncate text-xs text-muted-foreground">HTTP · every {Math.max(limits?.minIntervalS ?? 60, 60)} s · certificate expiry alerts</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Link
              to={`/monitors/new?site=${encodeURIComponent(s.siteId)}&type=http&url=${encodeURIComponent(s.url)}`}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={`Customize monitor for ${displayText(s.url)}`}
              title="Customize"
            >
              <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
            </Link>
            <Button type="button" size="default" onClick={() => void add(s)} disabled={busy !== null || done.has(s.url)}>
              {done.has(s.url) ? <CheckIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
              {done.has(s.url) ? 'Added' : busy === s.url ? 'Adding…' : 'Add'}
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
