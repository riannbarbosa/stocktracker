import type { FastifyInstance } from 'fastify';
import { SYMBOL_PATTERN } from '../lib/symbols.ts';
import { addToWatchlist, listWatchlist, removeFromWatchlist } from '../repositories/watchlists.ts';


const DEFAULT_OWNER = 'default';

const symbolBodySchema = {
    type: 'object',
    required: ['symbol'],
    additionalProperties: false,
    properties: {
        symbol: { type: 'string', pattern: SYMBOL_PATTERN, description: 'Ticker as listed on B3.' },
    },
} as const;

const symbolParamsSchema = {
    type: 'object',
    required: ['symbol'],
    properties: {
        symbol: { type: 'string', pattern: SYMBOL_PATTERN, description: 'Ticker as listed on B3.' },
    },
} as const;

/* Mirrors what items() in ../repositories/watchlists.ts returns. Fastify serializes
 * responses against this schema, so a field missing here is dropped from the payload. */
const watchlistItemSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer' },
        symbol: { type: 'string', description: 'Ticker as listed on B3.' },
        owner: { type: 'string', description: 'Owner the entry belongs to.' },
        createdAt: { type: 'string', description: 'ISO 8601.' },
    },
} as const;

const errorSchema = {
    type: 'object',
    properties: {
        error: { type: 'string' },
    },
} as const;

/* Shape Fastify emits when a request fails schema validation. */
const validationErrorSchema = {
    type: 'object',
    properties: {
        statusCode: { type: 'integer' },
        code: { type: 'string' },
        error: { type: 'string' },
        message: { type: 'string' },
    },
} as const;

export async function watchlistRoutes(app: FastifyInstance): Promise<void>  {
    app.get('/watchlist', {
        schema: {
            tags: ['watchlist'],
            summary: 'List the watchlist',
            description: `Returns every ticker tracked for the '${DEFAULT_OWNER}' owner.`,
            response: {
                200: { type: 'array', items: watchlistItemSchema },
            },
        },
    }, async () => listWatchlist(DEFAULT_OWNER));

    app.post<{ Body: { symbol: string } }>('/watchlist', {
        schema: {
            tags: ['watchlist'],
            summary: 'Add a ticker to the watchlist',
            description: 'Idempotent: adding a ticker already on the watchlist returns the existing entry.',
            body: symbolBodySchema,
            response: {
                201: watchlistItemSchema,
                400: validationErrorSchema,
            },
        },
    }, async (request, reply) => {
        const { symbol } = request.body as { symbol: string };
        const item = await addToWatchlist(DEFAULT_OWNER, symbol);
        reply.code(201).send(item);
    });

    app.delete<{ Params: { symbol: string } }>('/watchlist/:symbol', {
        schema: {
            tags: ['watchlist'],
            summary: 'Remove a ticker from the watchlist',
            params: symbolParamsSchema,
            response: {
                204: { type: 'null', description: 'Ticker removed.' },
                400: validationErrorSchema,
                404: errorSchema,
            },
        },
    }, async (request, reply) => {
        const removed = await removeFromWatchlist(DEFAULT_OWNER, request.params.symbol);
        if (!removed) {
            return reply.status(404).send({ error: 'Symbol not found in watchlist' });
        }
        reply.code(204).send();
    });
}
