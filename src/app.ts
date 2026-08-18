import  Fastify from "fastify";
import { config } from "./config.ts";
import { quoteRotes } from "./routes/quotes.ts";

export async function startServer(options = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
   ...options,    
  });

  app.get("/healthz", async () => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  app.register(quoteRotes);


  return app; 
}
