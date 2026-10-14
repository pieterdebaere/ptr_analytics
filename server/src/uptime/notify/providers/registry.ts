// Notification provider registry (docs/SPEC.md §8.3, ANALYSIS §4.5).
import type { ProviderDefinition } from '../../types.js';
import { discord } from './discord.js';
import { email } from './email.js';
import { googlechat } from './googlechat.js';
import { gotify } from './gotify.js';
import { homeassistant } from './homeassistant.js';
import { matrix } from './matrix.js';
import { mattermost } from './mattermost.js';
import { ntfy } from './ntfy.js';
import { opsgenie } from './opsgenie.js';
import { pagerduty } from './pagerduty.js';
import { pushbullet } from './pushbullet.js';
import { pushover } from './pushover.js';
import { rocketchat } from './rocketchat.js';
import { signal } from './signal.js';
import { slack } from './slack.js';
import { teams } from './teams.js';
import { telegram } from './telegram.js';
import { twilio } from './twilio.js';
import { webhook } from './webhook.js';
import { zulip } from './zulip.js';

const ALL = [
  email,
  webhook,
  slack,
  discord,
  telegram,
  teams,
  googlechat,
  mattermost,
  rocketchat,
  matrix,
  zulip,
  signal,
  ntfy,
  gotify,
  pushover,
  pushbullet,
  homeassistant,
  pagerduty,
  opsgenie,
  twilio,
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROVIDERS: ReadonlyMap<string, ProviderDefinition<any, any>> = new Map(ALL.map((p) => [p.id, p]));

/**
 * "Apprise-style" presets for the generic webhook: services that accept a plain JSON/form POST.
 * They only pre-fill the webhook form (`config`); nothing here is executed server-side.
 */
export interface WebhookPreset {
  id: string;
  label: string;
  help: string;
  config: { method: 'POST' | 'PUT'; contentType: 'json' | 'form' | 'text'; bodyTemplate: string };
  /** Header names the service expects (values are secrets the user fills in). */
  headerNames?: string[];
}

export const WEBHOOK_PRESETS: readonly WebhookPreset[] = [
  {
    id: 'grafana-oncall',
    label: 'Grafana OnCall',
    help: 'URL: the "Formatted webhook" integration URL.',
    config: {
      method: 'POST',
      contentType: 'json',
      bodyTemplate: '{"alert_uid": "{{monitor.uid}}", "title": "{{title}}", "message": "{{text}}", "state": "{{status}}", "link_to_upstream_details": "{{dashboard_url}}"}',
    },
  },
  {
    id: 'goalert',
    label: 'GoAlert',
    help: 'URL: <GoAlert>/api/v2/generic/incoming?token=… (keep the token secret: put it in a header if your proxy allows).',
    config: { method: 'POST', contentType: 'form', bodyTemplate: 'summary={{title}}\ndetails={{text}}\ndedup=ptr-{{monitor.uid}}\naction={{event}}' },
  },
  {
    id: 'alerta',
    label: 'Alerta',
    help: 'URL: <alerta>/api/alert. Header Authorization: Key <api key>.',
    headerNames: ['Authorization'],
    config: {
      method: 'POST',
      contentType: 'json',
      bodyTemplate:
        '{"resource": "{{monitor.name}}", "event": "{{event}}", "environment": "Production", "severity": "{{status}}", "service": ["{{site.name}}"], "text": "{{text}}", "origin": "ptr-analytics"}',
    },
  },
  {
    id: 'keep',
    label: 'Keep',
    help: 'URL: <keep>/alerts/event. Header x-api-key: <key>.',
    headerNames: ['x-api-key'],
    config: { method: 'POST', contentType: 'json', bodyTemplate: '{"id": "ptr-{{monitor.uid}}", "name": "{{title}}", "status": "{{status}}", "message": "{{text}}", "url": "{{dashboard_url}}"}' },
  },
  {
    id: 'squadcast',
    label: 'Squadcast',
    help: 'URL: the Incident Webhook URL of the service.',
    config: {
      method: 'POST',
      contentType: 'json',
      bodyTemplate: '{"message": "{{title}}", "description": "{{text}}", "event_id": "ptr-{{monitor.uid}}", "status": "{{event}}"}',
    },
  },
  {
    id: 'bark',
    label: 'Bark (v2)',
    help: 'URL: https://api.day.app/push (or your server). Put the device key in the body template.',
    config: { method: 'POST', contentType: 'json', bodyTemplate: '{"device_key": "YOUR_DEVICE_KEY", "title": "{{title}}", "body": "{{text}}", "group": "PTR Uptime"}' },
  },
  {
    id: 'waha',
    label: 'WAHA (WhatsApp HTTP API)',
    help: 'URL: <waha>/api/sendText. Header X-Api-Key: <key>.',
    headerNames: ['X-Api-Key'],
    config: { method: 'POST', contentType: 'json', bodyTemplate: '{"session": "default", "chatId": "123456789@c.us", "text": "{{title}}\\n{{text}}"}' },
  },
  {
    id: 'text',
    label: 'Plain text',
    help: 'Any endpoint accepting a text body.',
    config: { method: 'POST', contentType: 'text', bodyTemplate: '{{title}}\n{{text}}' },
  },
];
