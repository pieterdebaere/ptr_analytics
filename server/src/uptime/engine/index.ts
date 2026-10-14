// STUB created by the coordinator — owner: uptime core. Keep the export name and signature.
import type { AppContext } from '../../context.js';

export interface EngineHandle {
  stop(): Promise<void>;
}

/** Start the scheduler/check engine (only when background jobs run). */
export async function startEngine(_ctx: AppContext): Promise<EngineHandle> {
  return { stop: async () => {} };
}
