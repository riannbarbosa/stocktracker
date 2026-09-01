import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db/pool.ts';
import { isRedisReady } from '../redis/redis.ts';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/readyz', async (_request, reply) => {
    let database = true;
    try {
      await pingDatabase();
    } catch (error) {
      database = false;
      app.log.warn({ err: (error as Error).message }, 'readiness: database check failed');
    }

    const body = {
      status: database ? 'ready' : 'degraded',
      checks: { database, redis: isRedisReady() },
    };

    return reply.code(database ? 200 : 503).send(body);
  });
}