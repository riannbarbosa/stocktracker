import { buildApp } from './app.ts';
import { config } from './config.ts';
import { connectRedis, disconnectRedis } from './redis/redis.ts';
import { closeDatabase } from './db/pool.ts';
import { migrateDatabase } from './db/migrate.ts';
import { createAlertPoller } from './workers/alertPoller.ts';
import { createDigestWorker } from './workers/digestWorker.ts';

const app = await buildApp();

/* Postgres is required — alerts and the watchlist live there, so a boot without
 * a schema is a broken deploy, not a degraded one. */
await migrateDatabase((msg) => app.log.info({}, msg));

/* Redis is not awaited on purpose: the reconnect strategy retries forever, so
 * awaiting connect() would hang the boot while a cache outage should only cost
 * latency. isRedisReady() gates every cache access until it comes up. */
void connectRedis()
  .then(() => app.log.info({}, 'redis connected'))
  .catch((err: Error) => app.log.warn({ err: err.message }, 'redis unavailable, serving without cache'));

const poller = createAlertPoller(app.log);
if (config.alerts.pollerEnabled) {
  poller.start();
} else {
  app.log.info({}, 'alert poller disabled');
}

const digestWorker = createDigestWorker(app.log);
if (config.digest.enabled) {
  digestWorker.start();
} else {
  app.log.info({}, 'digest worker disabled');
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');
  try {
    await poller.stop();
    await digestWorker.stop();
    await app.close();
    await disconnectRedis();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error instanceof Error ? error.message : String(error) }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}