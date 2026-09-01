import  Fastify from "fastify";
import { config } from "./config.ts";
import { quoteRoutes, healthRoutes } from "./routes/index.ts";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
   ...options,    
  });

  app.register(healthRoutes);
  app.register(quoteRoutes);



  return app; 
}
