import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { connectRedis, disconnectRedis } from "./redis/redis.ts";


const app = await buildApp();

void connectRedis().then(() => app.log.info({}, 'redis connected')).catch((err) => {
  app.log.error({ err: err.message }, 'redis connection failed');
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown)  return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await disconnectRedis();
    process.exit(0);
  } catch (error) {
     app.log.error({ err: error instanceof Error ? error.message : String(error) }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}