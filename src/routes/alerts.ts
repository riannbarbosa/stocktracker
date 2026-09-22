import type { FastifyInstance } from 'fastify';
import { SYMBOL_PATTERN } from '../lib/symbols.ts';
import { createAlert, deleteAlert, findAlert, listAlerts } from '../repositories/alerts.ts';
import type { AlertDirection } from '../types/alerts.ts';

interface CreateAlertBody {
    symbol: string;
    direction: AlertDirection;
    targetPrice: number;
    webhookUrl?: string | null;
    email?: string | null;
}

const createBodySchema = {
    type: 'object',
    required: ['symbol', 'direction', 'targetPrice'],
    properties: {
        symbol: { type: 'string', pattern: SYMBOL_PATTERN, description: 'Ticker as listed on B3.' },
        direction: {
            type: 'string',
            enum: ['above', 'below'] as AlertDirection[],
            description: "Fire when the price crosses targetPrice in this direction.",
        },
        targetPrice: { type: 'number', description: 'Price that triggers the alert.' },
        webhookUrl: { type: ['string', 'null'], format: 'uri', description: 'POSTed to when the alert fires.' },
        email: { type: ['string', 'null'], format: 'email', description: 'Notified when the alert fires.' },
    },
} as const;

const idParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: {
        id: { type: 'integer', description: 'Alert id.' },
    },
} as const;

/* Mirrors what toAlert() in ../repositories/alerts.ts returns. Fastify serializes
 * responses against this schema, so a field missing here is dropped from the payload. */
const alertSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer' },
        symbol: { type: 'string', description: 'Ticker as listed on B3.' },
        direction: { type: 'string', enum: ['above', 'below'] as AlertDirection[] },
        targetPrice: { type: 'number', description: 'Price that triggers the alert.' },
        webhookUrl: { type: ['string', 'null'], description: 'POSTed to when the alert fires.' },
        email: { type: ['string', 'null'], description: 'Notified when the alert fires.' },
        active: { type: 'boolean', description: 'Whether the poller still evaluates this alert.' },
        firedAt: { type: ['string', 'null'], description: 'When the alert last fired (ISO 8601).' },
        lastPrice: { type: ['number', 'null'], description: 'Price seen at the last poll.' },
        lastCheckedAt: { type: ['string', 'null'], description: 'When the poller last evaluated it (ISO 8601).' },
        createdAt: { type: 'string', description: 'ISO 8601.' },
        updatedAt: { type: 'string', description: 'ISO 8601.' },
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

export async function alertRoutes(app: FastifyInstance): Promise<void> {
    app.get('/alerts', {
        schema: {
            tags: ['alerts'],
            summary: 'List all alerts',
            description: 'Returns every alert, most recently created first.',
            response: {
                200: { type: 'array', items: alertSchema },
            },
        },
    }, async() => listAlerts());

    app.get<{ Params: { id: number } }>('/alerts/:id', {
        schema: {
            tags: ['alerts'],
            summary: 'Fetch a single alert',
            params: idParamsSchema,
            response: {
                200: alertSchema,
                400: validationErrorSchema,
                404: errorSchema,
            },
        },
    }, async (request, reply) => {
        const alert = await findAlert(request.params.id);
        if (!alert) return reply.status(404).send({ error: 'Alert not found' });
        return alert;
    });

    app.post<{ Body: CreateAlertBody }>('/alerts', {
        schema: {
            tags: ['alerts'],
            summary: 'Create a price alert',
            description:
                'At least one notification method (webhookUrl or email) is required. ' +
                'The background poller evaluates the alert on each cycle.',
            body: createBodySchema,
            response: {
                201: alertSchema,
                400: validationErrorSchema,
            },
        },
    }, async(request, reply) => {
        if(!request.body.webhookUrl && !request.body.email) {
            return reply.status(400).send({ error: 'At least one notification method (webhookUrl or email) must be provided' });
        }
        const alert = await createAlert({
            symbol:  request.body.symbol,
            direction: request.body.direction,
            targetPrice: request.body.targetPrice,
            webhookUrl: request.body.webhookUrl ?? null,
            email: request.body.email ?? null,
        });
        return reply.status(201).send(alert);
    });

    app.delete<{ Params: { id: number } }>(
        '/alerts/:id',
        {
            schema: {
                tags: ['alerts'],
                summary: 'Delete an alert',
                description: 'Removes the alert so the background poller stops evaluating it.',
                params: idParamsSchema,
                response: {
                    204: { type: 'null', description: 'Alert deleted.' },
                    400: validationErrorSchema,
                    404: errorSchema,
                },
            },
        },
        async (request, reply) => {
        const deleted = await deleteAlert(request.params.id);
        if (!deleted) return reply.code(404).send({ error: 'alert not found' });
        return reply.code(204).send();
        },
  );
}
