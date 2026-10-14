// `cli monitors list|pause|resume` (ANALYSIS §8.5). A running server picks up pause/resume
// within a minute (the engine reconciles with the database periodically).
import type { DB } from '../../db/index.js';
import { MonitorRepo } from './monitors.js';

export const MONITORS_USAGE = `  cli monitors list [siteId]               list monitors (uid, site, type, status, name)
  cli monitors pause <uid>                 pause a monitor
  cli monitors resume <uid>                resume a monitor`;

const STATUS = ['down', 'up', 'pending', 'maint'];

export class MonitorsCliError extends Error {}

export function runMonitorsCli(db: DB, args: string[], out: (s: string) => void, printable: (s: string) => string, now = Date.now()): void {
  const [sub, arg] = args;
  const repo = new MonitorRepo(db);
  switch (sub) {
    case 'list': {
      if (arg !== undefined && !/^[a-z0-9]{12}$/.test(arg)) throw new MonitorsCliError('Invalid site id.');
      const list = repo.list(arg === undefined ? null : [arg]);
      if (list.length === 0) {
        out('No monitors.');
        return;
      }
      const states = repo.states(list.map((m) => m.id));
      for (const m of list) {
        const st = states.get(m.id)?.status ?? -1;
        const status = !m.active ? 'paused' : m.siteSuspended ? 'suspended' : (STATUS[st] ?? 'unknown');
        out(`${m.uid}  ${m.siteId}  ${m.type.padEnd(11)}  ${status.padEnd(9)}  ${printable(m.name)}`);
      }
      return;
    }
    case 'pause':
    case 'resume': {
      if (arg === undefined) throw new MonitorsCliError('A monitor uid is required.');
      const m = repo.byUid(arg);
      if (!m) throw new MonitorsCliError(`No monitor ${printable(arg)}.`);
      repo.setActive(m.id, sub === 'resume', now);
      out(`${sub === 'resume' ? 'Resumed' : 'Paused'} ${m.uid} (${printable(m.name)}). A running server applies this within a minute.`);
      return;
    }
    default:
      throw new MonitorsCliError(`Usage:\n${MONITORS_USAGE}`);
  }
}
