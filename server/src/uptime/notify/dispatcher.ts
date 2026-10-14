// STUB created by the coordinator — owner: notifications. Keep the export name and signature.
import type { AppContext } from '../../context.js';

export interface NotifierHandle {
  stop(): Promise<void>;
}

/** Start the outbox dispatcher (only when background jobs run). */
export function startNotifier(_ctx: AppContext): NotifierHandle {
  return { stop: async () => {} };
}
