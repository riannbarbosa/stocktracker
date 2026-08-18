import { getStockQuotes } from "../services/quotes.ts";
import { BrapiError } from "../services/brapi.ts";

const paramsSchema = {
  type: "object",
  required: ["symbols"],
  properties: {
    symbols: {
      type: "string",
      description: "Comma-separated list of stock symbols to fetch quotes for",
      pattern: '^[A-Za-z]{4}[0-9]{1,2}$'
    },
  },
  
}

export async function quoteRotes(app: any) {
  app.get('/quotes/:symbols', { schema: { params: paramsSchema, }}, async (request: any, reply: any) => {
    const { symbols } = request.params;
    try {
      return await getStockQuotes(symbols.split(','), { logger: app.log });
    }
    catch (error) {
      if (error instanceof BrapiError && error.status === 404) {
        return reply.status(error.status).send({ error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        request.log.error({ error: message, symbols }, 'failed to resolve quote');
        return reply.code(502).send({ error: 'market data provider unavailable' });
      }
    }
  }) 
}