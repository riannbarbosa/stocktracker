import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { fakePool, queryMatching, type FakePool, type QueryResult } from '../helpers/pg.ts';

const OWNER_ID = 42;

const ROW = {
  id: '5',
  alert_id: '1',
  symbol: 'PETR4',
  direction: 'below',
  target_price: '30.000000',
  price: '29.870000',
  read_at: null,
  created_at: new Date('2026-09-22T02:24:00.112Z'),
};

const NOTIFICATION = {
  id: 5,
  alertId: 1,
  symbol: 'PETR4',
  direction: 'below',
  targetPrice: 30,
  price: 29.87,
  readAt: null,
  createdAt: '2026-09-22T02:24:00.112Z',
};

/* The authenticate hook reads the account's token version before any handler
 * runs, so the queue is matched by statement rather than by call order. */
function respond(pg: FakePool, queued: QueryResult[]): void {
  let index = 0;
  pg.handle((sql) => {
    if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
    const next = queued[Math.min(index, queued.length - 1)];
    index += 1;
    return next ?? {};
  });
}

describe('routes/notifications', () => {
  let app: FastifyInstance;
  let pg: FakePool;
  let auth: { authorization: string };

  beforeEach(async () => {
    pg = fakePool();
    app = await buildApp({ logger: false });
    await app.ready();
    auth = { authorization: `Bearer ${app.jwt.sign({ sub: String(OWNER_ID), email: 'trader@example.test', ver: 0 })}` };
    respond(pg, []);
  });

  afterEach(async () => {
    await app.close();
    pg.restore();
  });

  describe('GET /notifications', () => {
    it('serves the owner\'s notifications with numeric prices', async () => {
      respond(pg, [{ rows: [ROW] }]);

      const response = await app.inject({ method: 'GET', url: '/notifications', headers: auth });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), [NOTIFICATION]);
      const select = queryMatching(pg.queries, 'FROM notifications');
      assert.deepEqual(select?.params, [OWNER_ID, false, 50]);
    });

    it('passes the unread filter and limit through', async () => {
      await app.inject({ method: 'GET', url: '/notifications?unread=true&limit=5', headers: auth });

      assert.deepEqual(queryMatching(pg.queries, 'FROM notifications')?.params, [OWNER_ID, true, 5]);
    });

    it('rejects a limit above 100', async () => {
      const response = await app.inject({ method: 'GET', url: '/notifications?limit=500', headers: auth });

      assert.equal(response.statusCode, 400);
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('returns the notification once marked', async () => {
      const readAt = new Date('2026-09-22T03:00:00.000Z');
      respond(pg, [{ rows: [{ ...ROW, read_at: readAt }] }]);

      const response = await app.inject({ method: 'PATCH', url: '/notifications/5/read', headers: auth });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().readAt, readAt.toISOString());
      assert.deepEqual(queryMatching(pg.queries, 'UPDATE notifications')?.params, [5, OWNER_ID]);
    });

    it('answers 404 for an id that is missing or not the caller\'s', async () => {
      respond(pg, [{ rows: [] }]);

      const response = await app.inject({ method: 'PATCH', url: '/notifications/99/read', headers: auth });

      assert.equal(response.statusCode, 404);
    });
  });

  describe('POST /notifications/read-all', () => {
    it('reports how many were unread', async () => {
      respond(pg, [{ rows: [], rowCount: 3 }]);

      const response = await app.inject({ method: 'POST', url: '/notifications/read-all', headers: auth });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { updated: 3 });
      assert.deepEqual(queryMatching(pg.queries, 'UPDATE notifications')?.params, [OWNER_ID]);
    });
  });

  describe('authentication', () => {
    it('refuses every route without a token', async () => {
      for (const [method, url] of [
        ['GET', '/notifications'],
        ['PATCH', '/notifications/5/read'],
        ['POST', '/notifications/read-all'],
      ] as const) {
        const response = await app.inject({ method, url });
        assert.equal(response.statusCode, 401, `${method} ${url} was reachable`);
      }
      assert.equal(queryMatching(pg.queries, 'notifications'), undefined, 'no query ran unauthenticated');
    });
  });
});
