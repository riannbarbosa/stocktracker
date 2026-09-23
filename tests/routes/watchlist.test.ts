import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { fakePool, queryMatching, type FakePool, type QueryResult } from '../helpers/pg.ts';

const OWNER_ID = 42;

const ROW = {
  id: '3',
  symbol: 'PETR4',
  owner_id: String(OWNER_ID),
  created_at: new Date('2026-09-04T20:06:00.000Z'),
};

const ITEM = { id: 3, symbol: 'PETR4', ownerId: OWNER_ID, createdAt: '2026-09-04T20:06:00.000Z' };

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

describe('routes/watchlist', () => {
  let app: FastifyInstance;
  let pg: FakePool;
  let auth: { authorization: string };

  beforeEach(async () => {
    pg = fakePool();
    app = await buildApp({ logger: false });
    await app.ready();
    /* Signed with the app's own key, so these exercise the real verify path. */
    auth = { authorization: `Bearer ${app.jwt.sign({ sub: String(OWNER_ID), email: 'trader@example.test', ver: 0 })}` };
    respond(pg, []);
  });

  afterEach(async () => {
    await app.close();
    pg.restore();
  });

  describe('GET /watchlist', () => {
    it('serves the tracked tickers', async () => {
      respond(pg, [{ rows: [ROW] }]);

      const response = await app.inject({ method: 'GET', url: '/watchlist', headers: auth });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), [ITEM]);
    });
  });

  describe('POST /watchlist', () => {
    it('creates an entry and answers 201', async () => {
      respond(pg, [{ rows: [ROW] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        headers: auth,
        payload: { symbol: 'petr4' },
      });

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), ITEM);
      assert.deepEqual(queryMatching(pg.queries, 'INSERT INTO')?.params, ['PETR4', OWNER_ID]);
    });

    it('rejects a ticker that is not shaped like a B3 symbol', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        headers: auth,
        payload: { symbol: '../../etc/passwd' },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(queryMatching(pg.queries, 'watchlist'), undefined, 'nothing reached the table');
    });

    it('rejects a body with no symbol', async () => {
      const response = await app.inject({ method: 'POST', url: '/watchlist', headers: auth, payload: {} });
      assert.equal(response.statusCode, 400);
    });

    /* Fastify's ajv runs with removeAdditional: true, so `additionalProperties:
     * false` strips the extra key rather than rejecting the body. Either way the
     * client cannot choose the owner — that is what this pins. */
    it('strips unknown properties instead of trusting them', async () => {
      respond(pg, [{ rows: [ROW] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        headers: auth,
        payload: { symbol: 'PETR4', ownerId: 999 },
      });

      assert.equal(response.statusCode, 201);
      assert.deepEqual(
        queryMatching(pg.queries, 'INSERT INTO')?.params,
        ['PETR4', OWNER_ID],
        'the owner comes from the token, never from the body',
      );
    });
  });

  describe('DELETE /watchlist/:symbol', () => {
    it('answers 204 with an empty body when the ticker was removed', async () => {
      respond(pg, [{ rowCount: 1 }]);

      const response = await app.inject({ method: 'DELETE', url: '/watchlist/PETR4', headers: auth });

      assert.equal(response.statusCode, 204);
      assert.equal(response.body, '');
    });

    it('answers 404 when the ticker was not on the list', async () => {
      respond(pg, [{ rowCount: 0 }]);

      const response = await app.inject({ method: 'DELETE', url: '/watchlist/PETR4', headers: auth });

      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'Symbol not found in watchlist' });
    });

    it('rejects a malformed ticker in the path', async () => {
      const response = await app.inject({ method: 'DELETE', url: '/watchlist/not%20a%20ticker', headers: auth });

      assert.equal(response.statusCode, 400);
      assert.equal(queryMatching(pg.queries, 'watchlist'), undefined, 'nothing reached the table');
    });
  });

  describe('authentication', () => {
    it('refuses every route without a token', async () => {
      for (const [method, url] of [['GET', '/watchlist'], ['POST', '/watchlist'], ['DELETE', '/watchlist/PETR4']] as const) {
        const response = await app.inject({ method, url, payload: { symbol: 'PETR4' } });
        assert.equal(response.statusCode, 401, `${method} ${url} was reachable`);
      }
      assert.equal(pg.queries.length, 0, 'nothing reached the database');
    });

    it('refuses a token this app did not sign', async () => {
      const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.not-a-real-signature';
      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${forged}` },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid or expired token' });
    });

    it('scopes the read to the id in the token', async () => {
      respond(pg, [{ rows: [ROW] }]);
      await app.inject({ method: 'GET', url: '/watchlist', headers: auth });

      assert.deepEqual(queryMatching(pg.queries, 'SELECT')?.params, [OWNER_ID]);
    });
  });

  describe('openapi spec', () => {
    /* An operation registered without `tags` is filed under a synthetic
     * "default" heading in Swagger UI, detached from its own resource. */
    it('tags every operation, so nothing lands in the default group', () => {
      const spec = app.swagger();
      const untagged: string[] = [];

      for (const [path, operations] of Object.entries(spec.paths ?? {})) {
        for (const [method, operation] of Object.entries(operations ?? {})) {
          const tags = (operation as { tags?: string[] }).tags;
          if (!tags || tags.length === 0) untagged.push(`${method.toUpperCase()} ${path}`);
        }
      }

      assert.deepEqual(untagged, []);
    });

    it('documents the watchlist operations under the watchlist tag', () => {
      const spec = app.swagger();
      const paths = spec.paths ?? {};

      assert.deepEqual((paths['/watchlist'] as Record<string, { tags?: string[] }>)?.get?.tags, ['watchlist']);
      assert.deepEqual((paths['/watchlist'] as Record<string, { tags?: string[] }>)?.post?.tags, ['watchlist']);
      assert.deepEqual(
        (paths['/watchlist/{symbol}'] as Record<string, { tags?: string[] }>)?.delete?.tags,
        ['watchlist'],
      );
    });
  });
});
