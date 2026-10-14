// /notifications — notification channels (docs/SPEC.md §8.3, ANALYSIS §4.1).
import { useEffect, useMemo, useState } from 'react';
import { BellIcon, CircleCheckIcon, EllipsisIcon, MailWarningIcon, PencilIcon, PlusIcon, ScrollTextIcon, SendIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { deliveryEventLabel, notifyApi, type DeliveryLogEntry, type NotificationChannel, type NotificationProvider, type ProviderCategory } from '@/api/notify';
import { FormMessage } from '@/components/AuthCard';
import { BackLink, EmptyState, ErrorState, PageHeader, SkeletonRows } from '@/components/common';
import { ChannelDialog } from '@/components/notify/ChannelDialog';
import { DeliveryLogSheet } from '@/components/notify/DeliveryLogSheet';
import { ProviderIcon } from '@/components/notify/ProviderIcon';
import { formatRelative } from '@/components/uptime/lib';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/auth';
import { useApi } from '@/hooks/useApi';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';

/**
 * Consecutive final failures (a notification given up after its retries) from which the
 * badge says "N failed in a row"; a single one, or a failed latest attempt, says
 * "Last delivery failed".
 */
export const FAILURE_WARNING_THRESHOLD = 2;
/** Channels whose latest delivery is looked up (one small log request each). */
const LAST_DELIVERY_LOOKUPS = 30;

type RowNotice = { kind: 'ok' | 'error'; text: string };

/** Message after "Resend confirmation". */
export function resendMessage(sent: number | null): RowNotice {
  if (sent === null) return { kind: 'ok', text: 'Confirmation e-mail sent again to unconfirmed recipients.' };
  if (sent === 0) {
    return {
      kind: 'error',
      text: 'No e-mail sent: the remaining recipients unsubscribed or declined, or already got a link in the last 10 minutes.',
    };
  }
  return { kind: 'ok', text: `Confirmation e-mail sent again to ${sent} ${sent === 1 ? 'recipient' : 'recipients'}.` };
}

/** Latest delivery-log entry per channel (best effort; failures are ignored). */
function useLastDeliveries(channels: readonly NotificationChannel[] | undefined): Record<string, DeliveryLogEntry | null> {
  const [last, setLast] = useState<Record<string, DeliveryLogEntry | null>>({});
  const key = (channels ?? [])
    .slice(0, LAST_DELIVERY_LOOKUPS)
    .map((c) => c.uid)
    .join(',');
  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    for (const uid of key.split(',')) {
      notifyApi.log(uid, 1, ctrl.signal).then(
        (entries) => setLast((l) => ({ ...l, [uid]: entries[0] ?? null })),
        () => {
          /* optional */
        },
      );
    }
    return () => ctrl.abort();
  }, [key]);
  return last;
}

export function NotificationsPage() {
  const { user, publicConfig } = useAuth();
  const hosted = publicConfig.signupEnabled && user?.role === 'member';
  const providers = useApi((signal) => notifyApi.providers(signal), []);
  const channels = useApi((signal) => notifyApi.listChannels(signal), []);
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null);
  const [logFor, setLogFor] = useState<NotificationChannel | null>(null);
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Partial<NotificationChannel>>>({});
  const [notices, setNotices] = useState<Record<string, RowNotice | 'testing'>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const lastDeliveries = useLastDeliveries(channels.data ?? undefined);
  const providerMap = useMemo(() => new Map((providers.data ?? []).map((p) => [p.id, p])), [providers.data]);
  const list = (channels.data ?? []).map((c) => ({ ...c, ...overrides[c.uid] }));

  const setActive = async (c: NotificationChannel, active: boolean) => {
    setOverrides((o) => ({ ...o, [c.uid]: { ...o[c.uid], active } }));
    try {
      const saved = await notifyApi.updateChannel(c.uid, { active });
      setOverrides((o) => ({ ...o, [c.uid]: saved }));
    } catch (e) {
      setOverrides((o) => ({ ...o, [c.uid]: { ...o[c.uid], active: !active } }));
      setNotices((n) => ({ ...n, [c.uid]: { kind: 'error', text: errorMessage(e) } }));
    }
  };

  const test = async (c: NotificationChannel) => {
    setNotices((n) => ({ ...n, [c.uid]: 'testing' }));
    try {
      const r = await notifyApi.testChannel(c.uid);
      setNotices((n) => ({ ...n, [c.uid]: r.ok ? { kind: 'ok', text: 'Test notification sent.' } : { kind: 'error', text: r.error ?? 'Sending failed.' } }));
    } catch (e) {
      setNotices((n) => ({ ...n, [c.uid]: { kind: 'error', text: errorMessage(e) || 'Sending failed.' } }));
    }
  };

  const resend = async (c: NotificationChannel) => {
    try {
      const r = await notifyApi.resendVerification(c.uid);
      setOverrides((o) => ({ ...o, [c.uid]: r.channel }));
      setNotices((n) => ({ ...n, [c.uid]: resendMessage(r.verificationSent) }));
    } catch (e) {
      setNotices((n) => ({ ...n, [c.uid]: { kind: 'error', text: errorMessage(e) } }));
    }
  };

  const remove = async (c: NotificationChannel) => {
    setBusy(true);
    setActionError(null);
    try {
      await notifyApi.deleteChannel(c.uid);
      setDeleting(null);
      channels.reload();
    } catch (e) {
      setActionError(errorMessage(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  const canAdd = !!providers.data && providers.data.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink to="/uptime">Uptime</BackLink>
        <PageHeader
          title="Notifications"
          description="Channels that alert you when a monitor goes down or comes back up, and before certificates or domains expire."
          actions={
            <Button type="button" onClick={() => setEditing('new')} disabled={!canAdd}>
              <PlusIcon aria-hidden="true" />
              Add channel
            </Button>
          }
        />
      </div>

      <Card className="gap-0 py-0">
        {channels.error ? (
          <ErrorState message={channels.error} onRetry={channels.reload} />
        ) : channels.loading && !channels.data ? (
          <SkeletonRows rows={3} className="p-4" />
        ) : list.length === 0 ? (
          <EmptyState title="No notification channels yet" icon={<BellIcon />} className="py-14">
            <p>Add e-mail, Slack, Discord, Telegram, webhooks and more. Then pick the channels per monitor.</p>
            <Button type="button" className="mt-4" onClick={() => setEditing('new')} disabled={!canAdd}>
              <PlusIcon aria-hidden="true" />
              Add channel
            </Button>
          </EmptyState>
        ) : (
          <ul className="divide-y" aria-label="Notification channels">
            {list.map((c) => (
              <ChannelRow
                key={c.uid}
                channel={c}
                provider={providerMap.get(c.type)}
                notice={notices[c.uid]}
                lastDelivery={lastDeliveries[c.uid] ?? null}
                onEdit={() => setEditing(c)}
                onLog={() => setLogFor(c)}
                onTest={() => void test(c)}
                onDelete={() => setDeleting(c)}
                onResend={() => void resend(c)}
                onActive={(a) => void setActive(c, a)}
              />
            ))}
          </ul>
        )}
      </Card>
      {actionError ? <FormMessage>{actionError}</FormMessage> : null}
      {providers.error ? <FormMessage>Could not load the provider list: {providers.error}</FormMessage> : null}

      {editing && providers.data ? (
        <ChannelDialog
          providers={providers.data}
          channel={editing === 'new' ? null : editing}
          hosted={hosted}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setOverrides((o) => {
              const { [saved.uid]: _drop, ...rest } = o;
              return rest;
            });
            channels.reload();
          }}
        />
      ) : null}
      {logFor ? <DeliveryLogSheet channel={logFor} onClose={() => setLogFor(null)} /> : null}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => (o ? undefined : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete channel</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong className="bidi-isolate break-all text-foreground">{deleting ? displayText(deleting.name) : ''}</strong>?
              {deleting && deleting.monitorCount > 0
                ? ` ${deleting.monitorCount} ${deleting.monitorCount === 1 ? 'monitor stops' : 'monitors stop'} sending alerts to it.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy || !deleting} onClick={() => deleting && void remove(deleting)}>
              Delete channel
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ChannelRow({
  channel: c,
  provider,
  notice,
  lastDelivery,
  onEdit,
  onLog,
  onTest,
  onDelete,
  onResend,
  onActive,
}: {
  channel: NotificationChannel;
  provider: NotificationProvider | undefined;
  notice: RowNotice | 'testing' | undefined;
  lastDelivery: DeliveryLogEntry | null;
  onEdit: () => void;
  onLog: () => void;
  onTest: () => void;
  onDelete: () => void;
  onResend: () => void;
  onActive: (active: boolean) => void;
}) {
  const category: ProviderCategory = provider?.category ?? (c.type === 'email' || c.type === 'smtp' ? 'email' : 'other');
  const lastFailed = lastDelivery !== null && !lastDelivery.ok;
  const failing = c.consecutiveFailures > 0 || lastFailed;
  const failTitle = lastFailed
    ? `${deliveryEventLabel(lastDelivery.event)} notification ${formatRelative(lastDelivery.ts)}: ${lastDelivery.error ?? (lastDelivery.httpStatus ? `HTTP ${lastDelivery.httpStatus}` : 'failed')}`
    : `The last ${c.consecutiveFailures === 1 ? 'notification' : `${c.consecutiveFailures} notifications`} could not be delivered.`;
  const unverified = !c.verified;
  const confirmed = c.recipients.filter((r) => r.verified && !r.unsubscribed).length;
  return (
    <li className={cn('flex flex-col gap-2 px-4 py-3.5 sm:px-5', !c.active && 'bg-muted/30')} data-channel={c.uid}>
      <div className="flex items-center gap-3">
        <ProviderIcon id={c.type} category={category} className={cn(!c.active && 'opacity-50')} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <button type="button" onClick={onEdit} className="bidi-isolate min-w-0 truncate text-left font-medium outline-none hover:underline hover:underline-offset-4 focus-visible:underline">
              {displayText(c.name) || 'Unnamed channel'}
            </button>
            {c.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            {unverified ? (
              <Badge
                className="bg-warn/15 text-warn-text"
                title="Recipients must confirm their address with the link we e-mailed them. Unconfirmed addresses receive no alerts."
                data-slot="unverified"
              >
                <MailWarningIcon aria-hidden="true" />
                {c.recipients.length > 1 ? `${confirmed} of ${c.recipients.length} confirmed` : 'Awaiting confirmation'}
              </Badge>
            ) : null}
            {c.autoDisabled ? (
              <Badge className="bg-poor/12 text-poor-text" title="Switched off after repeated failed deliveries. Fix the settings, send a test and turn it back on." data-slot="failing">
                <TriangleAlertIcon aria-hidden="true" />
                Disabled after {c.consecutiveFailures} failures
              </Badge>
            ) : failing ? (
              <Badge className="bg-poor/12 text-poor-text" title={displayText(failTitle)} data-slot="failing">
                <TriangleAlertIcon aria-hidden="true" />
                {c.consecutiveFailures >= FAILURE_WARNING_THRESHOLD ? `${c.consecutiveFailures} failed in a row` : 'Last delivery failed'}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{provider ? displayText(provider.label) : displayText(c.type)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {c.monitorCount === 0 ? 'No monitors' : `${c.monitorCount} ${c.monitorCount === 1 ? 'monitor' : 'monitors'}`}
            </span>
            {!c.active ? (
              <>
                <span aria-hidden="true">·</span>
                <span>Paused</span>
              </>
            ) : null}
          </div>
        </div>
        <Switch checked={c.active} onCheckedChange={onActive} aria-label={`${c.active ? 'Pause' : 'Activate'} ${c.name}`} />
        <Button type="button" variant="outline" size="sm" className="hidden sm:inline-flex" onClick={onLog}>
          <ScrollTextIcon aria-hidden="true" />
          Log
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} />}>
            <EllipsisIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onTest} disabled={notice === 'testing'}>
              <SendIcon aria-hidden="true" />
              Send test
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onLog}>
              <ScrollTextIcon aria-hidden="true" />
              Delivery log
            </DropdownMenuItem>
            {unverified && c.recipients.length > 0 ? (
              <DropdownMenuItem onClick={onResend}>
                <MailWarningIcon aria-hidden="true" />
                Resend confirmation
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2Icon aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {notice ? (
        <p
          className={cn(
            'ml-11 flex items-start gap-1.5 text-xs',
            notice === 'testing' ? 'text-muted-foreground' : notice.kind === 'ok' ? 'text-good-text' : 'text-destructive',
          )}
          role={notice !== 'testing' && notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice === 'testing' ? (
            'Sending test notification…'
          ) : (
            <>
              {notice.kind === 'ok' ? <CircleCheckIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" /> : <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />}
              <span className="bidi-isolate min-w-0 break-words">{displayText(notice.text)}</span>
            </>
          )}
        </p>
      ) : null}
    </li>
  );
}
