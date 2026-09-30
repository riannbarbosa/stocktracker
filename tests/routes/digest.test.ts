import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { fakePool, queryMatching, type FakePool, type QueryResult } from '../helpers/pg.ts';

const OWNER_ID = 42;

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

describe('routes/digest', () => {
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

  describe('GET /account/digest', () => {
    it('serves the caller\'s settings', async () => {
      const sentAt = new Date('2026-09-27T21:00:00.000Z');
      respond(pg, [{ rows: [{ digest_frequency: 'weekly', digest_last_sent_at: sentAt }] }]);

      const response = await app.inject({ method: 'GET', url: '/account/digest', headers: auth });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { frequency: 'weekly', lastSentAt: sentAt.toISOString() });
      assert.deepEqual(queryMatching(pg.queries, 'digest_frequency')?.params, [OWNER_ID]);
    });
  });

  describe('PUT /account/digest', () => {
    it('stores the frequency for the caller', async () => {
      respond(pg, [{ rows: [{ digest_frequency: 'daily', digest_last_sent_at: null }] }]);

      const response = await app.inject({
        method: 'PUT',
        url: '/account/digest',
        headers: auth,
        payload: { frequency: 'daily' },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { frequency: 'daily', lastSentAt: null });
      assert.deepEqual(queryMatching(pg.queries, 'UPDATE users')?.params, [OWNER_ID, 'daily']);
    });

    it('rejects a frequency it does not know', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/account/digest',
        headers: auth,
        payload: { frequency: 'hourly' },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(queryMatching(pg.queries, 'UPDATE users'), undefined);
    });

    it('answers 401 when the account no longer exists', async () => {
      respond(pg, [{ rows: [] }]);

      const response = await app.inject({
        method: 'PUT',
        url: '/account/digest',
        headers: auth,
        payload: { frequency: 'off' },
      });

      assert.equal(response.statusCode, 401);
    });
  });

  it('refuses both routes without a token', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({ method, url: '/account/digest', payload: method === 'PUT' ? { frequency: 'daily' } : undefined });
      assert.equal(response.statusCode, 401, `${method} /account/digest was reachable`);
    }
  });
});
