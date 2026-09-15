import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../db/pool.ts';
import { isRedisReady } from '../redis/redis.ts';

const livenessSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', description: "Always 'ok' when the process is serving." },
    uptimeSeconds: { type: 'integer', description: 'Seconds since process start.' },
  },
}

const readinessSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', description: "'ready' when the database answers, 'degraded' otherwise." },
    checks: {
      type: 'object',
      properties: {
        database: { type: 'boolean' },
        redis: { type: 'boolean' },
      },
    },
  },
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', {
    schema: {
      tags: ['health'],
      summary: 'Liveness probe',
      description: 'Succeeds whenever the process is up. Checks no dependencies.',
      response: { 200: livenessSchema },
    },
  }, async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/readyz', {
    schema: {
      tags: ['health'],
      summary: 'Readiness probe',
      description:
        'Pings Postgres and reports Redis connection state. Returns 503 when the ' +
        'database is unreachable; a down Redis is reported but does not fail the probe, ' +
        'since quotes still resolve from brapi without the cache.',
      response: { 200: readinessSchema, 503: readinessSchema },
    },
  }, async (_request, reply) => {
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
