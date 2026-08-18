import { startServer } from "./app.ts";
import { config } from "./config.ts";

const app = await startServer();

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
 //   await redis.quit();
    process.exit(0);
  } catch (err: any) {
    app.log.error({ err: err.message }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
