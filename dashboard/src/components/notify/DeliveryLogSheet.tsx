// Side sheet with the delivery log of one channel (GET /api/notification-channels/:uid/log).
import { useMemo } from 'react';
import { CircleAlertIcon, CircleCheckIcon, RotateCwIcon, ScrollTextIcon } from 'lucide-react';
import { notifyApi, deliveryEventLabel, type NotificationChannel } from '@/api/notify';
import { uptimeApi } from '@/api/uptime';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatRelative } from '@/components/uptime/lib';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

const EVENT_TONE: Record<string, string> = {
  down: 'bg-poor/12 text-poor',
  resend: 'bg-poor/12 text-poor',
  up: 'bg-good/12 text-good',
  cert: 'bg-warn/15 text-warn',
  domain: 'bg-warn/15 text-warn',
  maint_start: 'bg-chart-1/12 text-chart-1',
  maint_end: 'bg-chart-1/12 text-chart-1',
};

/** Right-hand sheet built on the dialog primitive (focus trap, Escape, scroll lock). */
export const SHEET_CLASS =
  'top-0 right-0 left-auto gap-0 h-dvh max-h-dvh w-full max-w-full translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] content-stretch rounded-none rounded-l-xl p-0 sm:max-w-2xl data-open:zoom-in-100 data-open:slide-in-from-right-8 data-closed:zoom-out-100 data-closed:slide-out-to-right-8';

export function DeliveryLogSheet({ channel, onClose }: { channel: NotificationChannel; onClose: () => void }) {
  const log = useApi((signal) => notifyApi.log(channel.uid, 100, signal), [channel.uid]);
  // Monitor names for the "Monitor" column (best effort).
  const monitors = useApi((signal) => uptimeApi.overview(signal).then((o) => o.monitors), []);
  const names = useMemo(() => new Map((monitors.data ?? []).map((m) => [m.uid, m.name])), [monitors.data]);
  const entries = log.data ?? [];
  const failed = entries.filter((e) => !e.ok).length;

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className={SHEET_CLASS} data-slot="delivery-log">
        <DialogHeader className="border-b px-4 py-4 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2">
            <ScrollTextIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            Delivery log
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2">
            <span className="bidi-isolate font-medium text-foreground">{displayText(channel.name)}</span>
            {entries.length ? (
              <span>
                · {entries.length} recent {entries.length === 1 ? 'delivery' : 'deliveries'}
                {failed ? `, ${failed} failed` : ''}
              </span>
            ) : null}
            <Button type="button" variant="ghost" size="xs" onClick={log.reload} className="ml-auto" disabled={log.loading}>
              <RotateCwIcon className={cn(log.loading && 'animate-spin')} aria-hidden="true" />
              Refresh
            </Button>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {log.error ? (
            <ErrorState message={log.error} onRetry={log.reload} />
          ) : log.loading && !log.data ? (
            <SkeletonRows rows={6} className="p-4" />
          ) : entries.length === 0 ? (
            <EmptyState title="No deliveries yet" icon={<ScrollTextIcon />}>
              Alerts and test messages sent through this channel appear here.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-popover">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 sm:pl-5">Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="hidden sm:table-cell">Monitor</TableHead>
                  <TableHead className="pr-4 sm:pr-5">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e, i) => {
                  const monitorName = e.monitorUid ? names.get(e.monitorUid) : undefined;
                  return (
                    <TableRow key={`${e.ts}-${i}`} data-ok={e.ok}>
                      <TableCell className="pl-4 align-top whitespace-nowrap tabular-nums sm:pl-5" title={new Date(e.ts).toISOString()}>
                        <div>{formatDateTime(e.ts, true)}</div>
                        <div className="text-xs text-muted-foreground">{formatRelative(e.ts)}</div>
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge className={cn(EVENT_TONE[e.event] ?? 'bg-muted text-muted-foreground')}>{deliveryEventLabel(e.event)}</Badge>
                        <div className="mt-1 max-w-40 truncate text-xs text-muted-foreground sm:hidden">{monitorName ? displayText(monitorName) : null}</div>
                      </TableCell>
                      <TableCell className="hidden max-w-48 align-top sm:table-cell">
                        <span className="bidi-isolate block truncate">{monitorName ? displayText(monitorName) : e.monitorUid ? '—' : <span className="text-muted-foreground">—</span>}</span>
                      </TableCell>
                      <TableCell className="max-w-56 pr-4 align-top whitespace-normal sm:pr-5">
                        {e.ok ? (
                          <span className="inline-flex items-center gap-1 text-good">
                            <CircleCheckIcon className="size-4" aria-hidden="true" />
                            Delivered
                            {e.httpStatus ? <span className="text-xs text-muted-foreground tabular-nums">({e.httpStatus})</span> : null}
                          </span>
                        ) : (
                          <span className="flex items-start gap-1 text-destructive">
                            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                            <span className="bidi-isolate min-w-0 text-sm break-words">
                              {e.httpStatus ? `HTTP ${e.httpStatus}${e.error ? ' · ' : ''}` : ''}
                              {e.error ? displayText(e.error.slice(0, 300)) : e.httpStatus ? '' : 'Failed'}
                            </span>
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
