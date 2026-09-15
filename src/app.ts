import  Fastify from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { config } from "./config.ts";
import { quoteRoutes, healthRoutes } from "./routes/index.ts";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
   ...options,    
  });

  /* Registered before the routes so the plugin can collect their schemas.
   * OpenAPI 3.1 because the response schemas use `type: ['string', 'null']`,
   * which 3.0 does not allow. */
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'StockTracker API',
        description: 'REST API serving B3 stock quotes, cached in Redis.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.port}`, description: 'Local' }],
      tags: [
        { name: 'quotes', description: 'B3 stock quotes.' },
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



  return app; 
}
