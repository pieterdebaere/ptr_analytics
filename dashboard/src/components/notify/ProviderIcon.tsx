import type { ComponentType } from 'react';
import {
  BellRingIcon,
  HouseIcon,
  MailIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  PlugIcon,
  SendIcon,
  SirenIcon,
  SmartphoneIcon,
  WebhookIcon,
} from 'lucide-react';
import type { ProviderCategory } from '@/api/notify';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;

const CATEGORY_ICON: Record<ProviderCategory, Icon> = {
  chat: MessageSquareIcon,
  push: BellRingIcon,
  incident: SirenIcon,
  email: MailIcon,
  sms: SmartphoneIcon,
  webhook: WebhookIcon,
  other: PlugIcon,
};

const CATEGORY_TINT: Record<ProviderCategory, string> = {
  chat: 'bg-chart-3/12 text-chart-3',
  push: 'bg-chart-4/15 text-chart-4',
  incident: 'bg-poor/10 text-poor',
  email: 'bg-chart-1/10 text-chart-1',
  sms: 'bg-good/10 text-good',
  webhook: 'bg-chart-2/12 text-chart-2',
  other: 'bg-muted text-muted-foreground',
};

function iconFor(id: string, category: ProviderCategory): Icon {
  if (/telegram/.test(id)) return SendIcon;
  if (/signal|whatsapp|line|wecom|feishu|dingding|dingtalk/.test(id)) return MessageCircleIcon;
  if (/home-?assistant/.test(id)) return HouseIcon;
  if (/mail|smtp/.test(id)) return MailIcon;
  if (/webhook/.test(id)) return WebhookIcon;
  return CATEGORY_ICON[category];
}

/** Rounded tile with a generic icon for the provider (no third-party logos). */
export function ProviderIcon({ id, category, className }: { id: string; category: ProviderCategory; className?: string }) {
  const I = iconFor(id, category);
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', CATEGORY_TINT[category], className)} aria-hidden="true">
      <I className="size-4" />
    </span>
  );
}
