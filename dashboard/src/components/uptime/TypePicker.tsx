import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeftRightIcon,
  BracesIcon,
  CableIcon,
  CalendarClockIcon,
  ClockIcon,
  ContainerIcon,
  DatabaseIcon,
  FolderTreeIcon,
  GlobeIcon,
  HandIcon,
  MailIcon,
  NetworkIcon,
  RadarIcon,
  RadioTowerIcon,
  SendIcon,
  ServerIcon,
  ShieldCheckIcon,
  TerminalIcon,
  TextSearchIcon,
  ActivityIcon,
} from 'lucide-react';
import { CATEGORY_LABELS, type CheckerCategory, type MonitorTypeInfo } from '@/api/uptime';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  http: GlobeIcon,
  keyword: TextSearchIcon,
  json: BracesIcon,
  tcp: CableIcon,
  tls: ShieldCheckIcon,
  dns: NetworkIcon,
  push: SendIcon,
  group: FolderTreeIcon,
  manual: HandIcon,
  ping: RadarIcon,
  websocket: ArrowLeftRightIcon,
  smtp: MailIcon,
  ntp: ClockIcon,
  redis: DatabaseIcon,
  ssh: TerminalIcon,
  grpc_health: ServerIcon,
  postgres: DatabaseIcon,
  mysql: DatabaseIcon,
  mongodb: DatabaseIcon,
  mqtt: RadioTowerIcon,
  docker: ContainerIcon,
  domain: CalendarClockIcon,
};

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = ICONS[type] ?? ActivityIcon;
  return <Icon className={className} aria-hidden="true" />;
}

const ORDER: CheckerCategory[] = ['web', 'network', 'protocol', 'infrastructure', 'passive'];

/** Why a type cannot be picked, or null. */
export function unavailableReason(t: MonitorTypeInfo, hosted: boolean): string | null {
  if (!t.available) return 'Not available on this server';
  if (hosted && !t.hostedAllowed) return 'Not available on the hosted plan';
  return null;
}

export function TypePicker({ types, hosted, onPick }: { types: readonly MonitorTypeInfo[]; hosted: boolean; onPick: (type: string) => void }) {
  const groups = ORDER.map((c) => ({ category: c, types: types.filter((t) => t.category === c) })).filter((g) => g.types.length > 0);
  return (
    <div className="flex flex-col gap-8">
      {groups.map((g) => (
        <section key={g.category} aria-labelledby={`cat-${g.category}`} className="flex flex-col gap-3">
          <h2 id={`cat-${g.category}`} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {CATEGORY_LABELS[g.category]}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {g.types.map((t) => {
              const reason = unavailableReason(t, hosted);
              return (
                <button
                  key={t.type}
                  type="button"
                  disabled={reason !== null}
                  onClick={() => onPick(t.type)}
                  data-type={t.type}
                  className={cn(
                    'group/type flex min-w-0 items-start gap-3 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 outline-none transition-all hover:ring-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/50',
                    'disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:ring-foreground/10',
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground transition-colors group-enabled/type:group-hover/type:bg-primary group-enabled/type:group-hover/type:text-primary-foreground">
                    <TypeIcon type={t.type} className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{t.description}</span>
                    {reason ? <span className="mt-1 text-xs font-medium text-warn">{reason}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
