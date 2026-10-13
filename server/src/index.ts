#!/usr/bin/env node
import fs from 'node:fs';
import { buildApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';

// Files we create (database, WAL, GeoIP database) are readable by the owner only.
process.umask(0o077);

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const app = await buildApp(config, { backgroundJobs: true });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`Received ${signal}, shutting down`);
    const force = setTimeout(() => {
      app.log.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'Error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  console.error('Fatal error during startup:', err instanceof Error ? err.message : err);
  process.exit(1);
});
