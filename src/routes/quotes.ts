import { getStockQuotes } from "../services/quotes.ts";
import { BrapiError } from "../services/brapi.ts";
import type { FastifyInstance } from "fastify";
import { symbolListPattern } from "../lib/symbols.ts";
import { config } from "../config.ts";

const paramsSchema = {
  type: "object",
  required: ["symbols"],
  properties: {
    symbols: {
      type: "string",
      description: `Comma-separated stock symbols (max ${config.quotes.maxSymbolsPerRequest})`,
      pattern: symbolListPattern(),
    },
  },
  
}

/* Mirrors StockQuote in ../types/brapi.ts. Fastify serializes responses against
 * this schema, so a field missing here is silently dropped from the payload. */
const stockQuoteSchema = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "Ticker as listed on B3." },
    name: { type: ["string", "null"], description: "Company short or long name." },
    currency: { type: ["string", "null"], description: "Quote currency, e.g. BRL." },
    price: { type: ["number", "null"], description: "Last traded price." },
    dayHigh: { type: ["number", "null"], description: "Session high." },
    dayLow: { type: ["number", "null"], description: "Session low." },
    change: { type: ["number", "null"], description: "Absolute change since previous close." },
    changePercent: { type: ["number", "null"], description: "Percentage change since previous close." },
    time: { type: ["string", "null"], description: "Provider quote timestamp (ISO 8601)." },
    marketCap: { type: ["number", "null"], description: "Market capitalization." },
    volume: { type: ["number", "null"], description: "Session volume." },
    logoUrl: { type: ["string", "null"], description: "Company logo." },
    fetchedAt: { type: "string", description: "When this API produced the value (ISO 8601)." },
  },
}

const errorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
}

/* Shape Fastify emits when a request fails `paramsSchema` validation. */
const validationErrorSchema = {
  type: "object",
  properties: {
    statusCode: { type: "integer" },
    code: { type: "string" },
    error: { type: "string" },
    message: { type: "string" },
  },
}

export async function quoteRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { symbols: string } }>('/quotes/:symbols', {
    schema: {
      tags: ['quotes'],
      summary: 'Fetch quotes for one or more symbols',
      description:
        'Returns a normalized quote per symbol. Results are served from Redis when ' +
        `cached (TTL ${config.quotes.cacheTtlSeconds}s) and fetched from brapi otherwise. ` +
        'The `x-cache` response header reports HIT, MISS, or PARTIAL.',
      params: paramsSchema,
      response: {
        200: {
          type: 'array',
          description: 'One entry per requested symbol, in request order.',
          items: stockQuoteSchema,
        },
        400: validationErrorSchema,
        404: errorSchema,
        502: errorSchema,
      },
    },
  }, async (request, reply) => {
    const requested = request.params.symbols.split(',');
    try {
      const { quotes, cacheHits, cacheMisses } = await getStockQuotes(requested, { logger: app.log });
      const cacheStatus = cacheMisses.length === 0 ? 'HIT' : cacheHits.length === 0 ? 'MISS' : 'PARTIAL';
      return reply.header('x-cache', cacheStatus).send(quotes);
    }
    catch (error) {
      if (error instanceof BrapiError && error.status === 404) {
        return reply.status(error.status).send({ error: error.message });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        request.log.error({ error: message, symbols: requested }, 'failed to resolve quote');
        return reply.code(502).send({ error: 'market data provider unavailable' });
      }
    }
  }) 
}
