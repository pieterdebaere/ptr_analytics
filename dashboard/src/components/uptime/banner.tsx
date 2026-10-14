import { Link } from 'react-router-dom';
import { AlertTriangleIcon } from 'lucide-react';
import type { Monitor } from '@/api/uptime';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { displayText } from '@/lib/safety';
import { formatDurationMs } from './lib';

/** Red banner listing monitors that are currently DOWN (links to their detail pages). */
export function DownBanner({ monitors, siteNames, max = 4 }: { monitors: readonly Monitor[]; siteNames?: ReadonlyMap<string, string>; max?: number }) {
  if (monitors.length === 0) return null;
  const now = Date.now();
  const shown = monitors.slice(0, max);
  return (
    <Alert className="border-poor/40 bg-poor/6 text-foreground" data-slot="down-banner">
      <AlertTriangleIcon className="text-poor" aria-hidden="true" />
      <AlertTitle>
        {monitors.length === 1 ? '1 monitor is down' : `${monitors.length} monitors are down`}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-0.5">
          {shown.map((m) => {
            const site = siteNames?.get(m.siteId);
            return (
              <li key={m.uid} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <Link to={`/monitors/${encodeURIComponent(m.uid)}`} className="bidi-isolate font-medium text-foreground underline-offset-4 hover:underline">
                  {displayText(m.name)}
                </Link>
                {site ? <span className="bidi-isolate text-muted-foreground">· {displayText(site)}</span> : null}
                {m.state.since ? <span className="text-muted-foreground">· for {formatDurationMs(now - m.state.since)}</span> : null}
                {m.state.msg ? <span className="bidi-isolate min-w-0 truncate text-muted-foreground">· {displayText(m.state.msg)}</span> : null}
              </li>
            );
          })}
          {monitors.length > shown.length ? (
            <li>
              <Link to="/uptime?status=down" className="font-medium text-foreground underline-offset-4 hover:underline">
                and {monitors.length - shown.length} more
              </Link>
            </li>
          ) : null}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
