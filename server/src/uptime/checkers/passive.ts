// Engine-driven types without check(): `push` (dead-man's switch fed by /api/push/:token),
// `group` (status derived from children) and `manual` (status set by a user).
import type { CheckerDefinition } from '../types.js';

type Empty = Record<string, never>;

export const pushChecker: CheckerDefinition<Empty, Empty> = {
  type: 'push',
  label: 'Push (heartbeat)',
  description: 'Passive monitor: your job calls the push URL; DOWN when no push arrives within the interval.',
  category: 'passive',
  fields: [],
  defaults: { intervalS: 300, timeoutMs: 10_000, retries: 0 },
  hosted: 'allowed',
  validate: () => ({ config: {}, secrets: {} }),
  target: () => null,
};

export const groupChecker: CheckerDefinition<Empty, Empty> = {
  type: 'group',
  label: 'Group',
  description: 'Groups monitors; DOWN when a child is down, PENDING while a child is pending.',
  category: 'passive',
  fields: [],
  defaults: { intervalS: 60, timeoutMs: 10_000, retries: 0 },
  hosted: 'allowed',
  validate: () => ({ config: {}, secrets: {} }),
  target: () => null,
};

export const manualChecker: CheckerDefinition<Empty, Empty> = {
  type: 'manual',
  label: 'Manual',
  description: 'Status set by hand (e.g. for third-party components on a status page).',
  category: 'passive',
  fields: [],
  defaults: { intervalS: 300, timeoutMs: 10_000, retries: 0 },
  hosted: 'allowed',
  validate: () => ({ config: {}, secrets: {} }),
  target: () => null,
};
