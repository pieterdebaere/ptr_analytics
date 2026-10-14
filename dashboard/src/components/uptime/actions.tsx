import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CopyIcon, MoreHorizontalIcon, PauseIcon, PencilIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { uptimeApi, type Monitor } from '@/api/uptime';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { displayText } from '@/lib/safety';
import { cn } from '@/lib/utils';
import { toast } from './toast';

/** Confirmation dialog with async confirm, busy state and inline error. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setError(null);
        onOpenChange(o);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (err) {
                setError(errorMessage(err) || 'Something went wrong.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface MonitorActionHandlers {
  onChanged: (m: Monitor) => void;
  onRemoved: (uid: string) => void;
  /** Called when the server answered without a monitor body (re-fetch). */
  onReload?: () => void;
}

/** Shared implementations of the monitor actions (pause/resume, check, clone, delete). */
export function useMonitorActions(monitor: Monitor, h: MonitorActionHandlers) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err) || 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const name = displayText(monitor.name);
  return {
    busy,
    togglePause: () =>
      run('pause', async () => {
        const m = monitor.active ? await uptimeApi.pauseMonitor(monitor.uid) : await uptimeApi.resumeMonitor(monitor.uid);
        if (m) h.onChanged(m);
        else {
          h.onChanged({ ...monitor, active: !monitor.active });
          h.onReload?.();
        }
        toast(monitor.active ? `Paused ${name}` : `Resumed ${name}`);
      }),
    checkNow: () =>
      run('check', async () => {
        await uptimeApi.checkMonitor(monitor.uid);
        toast(`Check of ${name} started`, 'info');
      }),
    clone: () =>
      run('clone', async () => {
        const m = await uptimeApi.cloneMonitor(monitor.uid);
        if (m) navigate(`/monitors/${encodeURIComponent(m.uid)}/edit?cloned=1`);
        else {
          toast(`Cloned ${name}`);
          h.onReload?.();
        }
      }),
    remove: async () => {
      await uptimeApi.deleteMonitor(monitor.uid);
      h.onRemoved(monitor.uid);
      toast(`Deleted ${name}`);
    },
  };
}

export function DeleteMonitorDialog({ monitor, open, onOpenChange, onDelete }: { monitor: Monitor; open: boolean; onOpenChange: (o: boolean) => void; onDelete: () => Promise<void> }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete monitor?"
      description={
        <>
          <strong className="bidi-isolate font-medium text-foreground">{displayText(monitor.name)}</strong> and its check history,
          outages and badges will be deleted. This cannot be undone.
        </>
      }
      confirmLabel="Delete monitor"
      destructive
      onConfirm={onDelete}
    />
  );
}

/** "…" menu for a monitor row. */
export function MonitorActionsMenu({ monitor, canManage, className, ...h }: MonitorActionHandlers & { monitor: Monitor; canManage: boolean; className?: string }) {
  const navigate = useNavigate();
  const a = useMonitorActions(monitor, h);
  const [confirm, setConfirm] = useState(false);
  if (!canManage) return null;
  const editHref = `/monitors/${encodeURIComponent(monitor.uid)}/edit`;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground max-sm:size-8', className)} aria-label={`Actions for ${displayText(monitor.name)}`} />}
        >
          {a.busy ? <RefreshCwIcon className="animate-spin" aria-hidden="true" /> : <MoreHorizontalIcon aria-hidden="true" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={a.togglePause} disabled={a.busy !== null}>
              {monitor.active ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
              {monitor.active ? 'Pause' : 'Resume'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={a.checkNow} disabled={a.busy !== null || !monitor.active || monitor.type === 'push' || monitor.type === 'group'}>
              <RefreshCwIcon aria-hidden="true" />
              Check now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate(editHref)}>
              <PencilIcon aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={a.clone} disabled={a.busy !== null}>
              <CopyIcon aria-hidden="true" />
              Clone
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2Icon aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteMonitorDialog monitor={monitor} open={confirm} onOpenChange={setConfirm} onDelete={a.remove} />
    </>
  );
}
