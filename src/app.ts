import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { config } from './config.ts';
import { healthRoutes } from './routes/health.ts';
import { quoteRoutes } from './routes/quotes.ts';
import { alertRoutes } from './routes/alerts.ts';
import { watchlistRoutes } from './routes/watchlist.ts'

export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
     ajv: { customOptions: { strict: false } },
   ...options,    
  });

  /* Registered before the routes: @fastify/swagger collects each route's schema
   * as it is added, so anything registered earlier is missing from the spec. */
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'stocktracker-api',
        description:
          'REST API serving B3 stock quotes with Redis caching, plus price alerts ' +
          'evaluated by a background poller.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.port}`, description: 'Local' }],
      tags: [
        { name: 'quotes', description: 'B3 quote lookups, served from Redis when cached.' },
        { name: 'watchlist', description: 'Tickers tracked for an owner.' },
        { name: 'alerts', description: 'Price alerts evaluated by the background poller.' },
        { name: 'health', description: 'Liveness and readiness probes.' },
      ],
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  app.register(healthRoutes);
  app.register(quoteRoutes);
  app.register(alertRoutes);
  app.register(watchlistRoutes);

  return app; 
}
