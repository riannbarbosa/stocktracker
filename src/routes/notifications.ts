import type { FastifyInstance } from 'fastify';
import { ownerOf } from '../plugins/authenticate.ts';
import {
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
} from '../repositories/notifications.ts';
import type { AlertDirection } from '../types/alerts.ts';

const listQuerySchema = {
    type: 'object',
    properties: {
        unread: { type: 'boolean', default: false, description: 'Only return notifications not yet read.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Most recent first.' },
    },
} as const;

const idParamsSchema = {
    type: 'object',
    required: ['id'],
    properties: {
        id: { type: 'integer', description: 'Notification id.' },
    },
} as const;

/* Mirrors what toNotification() in ../repositories/notifications.ts returns.
 * Fastify serializes responses against this schema, so a field missing here is
 * dropped from the payload. */
const notificationSchema = {
    type: 'object',
    properties: {
        id: { type: 'integer' },
        alertId: { type: ['integer', 'null'], description: 'Alert that fired; null once that alert is deleted.' },
        symbol: { type: 'string', description: 'Ticker as listed on B3.' },
        direction: { type: 'string', enum: ['above', 'below'] as AlertDirection[] },
        targetPrice: { type: 'number', description: 'Target the alert was set to when it fired.' },
        price: { type: 'number', description: 'Price that triggered it.' },
        readAt: { type: ['string', 'null'], description: 'When it was marked read (ISO 8601); null while unread.' },
        createdAt: { type: 'string', description: 'When the alert fired (ISO 8601).' },
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

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { unread: boolean; limit: number } }>('/notifications', {
        schema: {
            tags: ['notifications'],
            security: [{ bearerAuth: [] }],
            summary: 'List notifications',
            description: 'One entry per alert firing, most recent first.',
            querystring: listQuerySchema,
            response: {
                200: { type: 'array', items: notificationSchema },
                400: validationErrorSchema,
                401: errorSchema,
            },
        },
    }, async (request) => listNotifications(ownerOf(request), {
        unreadOnly: request.query.unread,
        limit: request.query.limit,
    }));

    app.patch<{ Params: { id: number } }>('/notifications/:id/read', {
        schema: {
            tags: ['notifications'],
            security: [{ bearerAuth: [] }],
            summary: 'Mark a notification as read',
            description: 'Idempotent: an already-read notification keeps its original readAt.',
            params: idParamsSchema,
            response: {
                200: notificationSchema,
                400: validationErrorSchema,
                401: errorSchema,
                404: errorSchema,
            },
        },
    }, async (request, reply) => {
        const notification = await markNotificationRead(request.params.id, ownerOf(request));
        if (!notification) return reply.status(404).send({ error: 'Notification not found' });
        return notification;
    });

    app.post('/notifications/read-all', {
        schema: {
            tags: ['notifications'],
            security: [{ bearerAuth: [] }],
            summary: 'Mark every notification as read',
            response: {
                200: {
                    type: 'object',
                    properties: {
                        updated: { type: 'integer', description: 'How many were unread before this call.' },
                    },
                },
                401: errorSchema,
            },
        },
    }, async (request) => ({ updated: await markAllNotificationsRead(ownerOf(request)) }));
}
