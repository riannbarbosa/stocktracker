import type { FastifyInstance } from 'fastify';
import { ownerOf } from '../plugins/authenticate.ts';
import { getDigestSettings, setDigestFrequency } from '../repositories/digest.ts';
import { DIGEST_FREQUENCIES, type DigestFrequency } from '../types/digest.ts';

const settingsSchema = {
    type: 'object',
    properties: {
        frequency: { type: 'string', enum: DIGEST_FREQUENCIES, description: 'How often the watchlist summary is emailed.' },
        lastSentAt: { type: ['string', 'null'], description: 'When the last summary went out (ISO 8601).' },
    },
} as const;

const updateBodySchema = {
    type: 'object',
    required: ['frequency'],
    additionalProperties: false,
    properties: {
        frequency: { type: 'string', enum: DIGEST_FREQUENCIES },
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

export async function digestRoutes(app: FastifyInstance): Promise<void> {
    app.get('/account/digest', {
        schema: {
            tags: ['digest'],
            security: [{ bearerAuth: [] }],
            summary: 'Read the watchlist summary settings',
            response: {
                200: settingsSchema,
                401: errorSchema,
            },
        },
    }, async (request, reply) => {
        const settings = await getDigestSettings(ownerOf(request));
        /* The token verified, so a missing row means the account was deleted. */
        if (!settings) return reply.code(401).send({ error: 'invalid or expired token' });
        return settings;
    });

    app.put<{ Body: { frequency: DigestFrequency } }>('/account/digest', {
        schema: {
            tags: ['digest'],
            security: [{ bearerAuth: [] }],
            summary: 'Set how often the watchlist summary is emailed',
            description:
                'Summaries go out after the configured hour (DIGEST_SEND_HOUR, local to ' +
                'DIGEST_TIME_ZONE) to the account email. "off" stops them.',
            body: updateBodySchema,
            response: {
                200: settingsSchema,
                400: validationErrorSchema,
                401: errorSchema,
            },
        },
    }, async (request, reply) => {
        const settings = await setDigestFrequency(ownerOf(request), request.body.frequency);
        if (!settings) return reply.code(401).send({ error: 'invalid or expired token' });
        return settings;
    });
}
