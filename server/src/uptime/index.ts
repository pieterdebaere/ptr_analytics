// Wiring of the uptime module (docs/SPEC.md §8). Coordinator-owned: agents implement the
// modules imported here and keep their export names.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { monitorRoutes } from './api/monitors.js';
import { pushRoutes } from './api/push.js';
import { startEngine } from './engine/index.js';
import { notifyRoutes } from './notify/api.js';
import { startNotifier } from './notify/dispatcher.js';
import { publicStatusRoutes } from './status/public.js';
import { statusPageRoutes } from './status/api.js';

export async function registerUptime(app: FastifyInstance, ctx: AppContext, opts: { backgroundJobs: boolean }): Promise<void> {
  if (!ctx.config.uptime.enabled) return;
  await app.register(monitorRoutes, { ctx });
  await app.register(pushRoutes, { ctx });
  await app.register(notifyRoutes, { ctx });
  await app.register(statusPageRoutes, { ctx });
  await app.register(publicStatusRoutes, { ctx });
  if (opts.backgroundJobs) {
    const engine = await startEngine(ctx);
    const notifier = startNotifier(ctx);
    app.addHook('onClose', async () => {
      await engine.stop();
      await notifier.stop();
    });
  }
}
