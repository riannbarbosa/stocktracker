import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';

const ROW = {
  id: '3',
  symbol: 'PETR4',
  owner: 'default',
  created_at: new Date('2026-09-04T20:06:00.000Z'),
};

const ITEM = { id: 3, symbol: 'PETR4', owner: 'default', createdAt: '2026-09-04T20:06:00.000Z' };

describe('routes/watchlist', () => {
  let app: FastifyInstance;
  let pg: FakePool;

  beforeEach(async () => {
    pg = fakePool();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    pg.restore();
  });

  describe('GET /watchlist', () => {
    it('serves the tracked tickers', async () => {
      pg.results([{ rows: [ROW] }]);

      const response = await app.inject({ method: 'GET', url: '/watchlist' });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), [ITEM]);
    });
  });

  describe('POST /watchlist', () => {
    it('creates an entry and answers 201', async () => {
      pg.results([{ rows: [ROW] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        payload: { symbol: 'petr4' },
      });

      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), ITEM);
      assert.deepEqual(queryMatching(pg.queries, 'INSERT INTO')?.params, ['PETR4', 'default']);
    });

    it('rejects a ticker that is not shaped like a B3 symbol', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        payload: { symbol: '../../etc/passwd' },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(pg.queries.length, 0, 'nothing reaches the database');
    });

    it('rejects a body with no symbol', async () => {
      const response = await app.inject({ method: 'POST', url: '/watchlist', payload: {} });
      assert.equal(response.statusCode, 400);
    });

    /* Fastify's ajv runs with removeAdditional: true, so `additionalProperties:
     * false` strips the extra key rather than rejecting the body. Either way the
     * client cannot choose the owner — that is what this pins. */
    it('strips unknown properties instead of trusting them', async () => {
      pg.results([{ rows: [ROW] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/watchlist',
        payload: { symbol: 'PETR4', owner: 'someone-else' },
      });

      assert.equal(response.statusCode, 201);
      assert.deepEqual(
        queryMatching(pg.queries, 'INSERT INTO')?.params,
        ['PETR4', 'default'],
        'owner comes from the server, never from the body',
      );
    });
  });

  describe('DELETE /watchlist/:symbol', () => {
    it('answers 204 with an empty body when the ticker was removed', async () => {
      pg.results([{ rowCount: 1 }]);

      const response = await app.inject({ method: 'DELETE', url: '/watchlist/PETR4' });

      assert.equal(response.statusCode, 204);
      assert.equal(response.body, '');
    });

    it('answers 404 when the ticker was not on the list', async () => {
      pg.results([{ rowCount: 0 }]);

      const response = await app.inject({ method: 'DELETE', url: '/watchlist/PETR4' });

      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: 'Symbol not found in watchlist' });
    });

    it('rejects a malformed ticker in the path', async () => {
      const response = await app.inject({ method: 'DELETE', url: '/watchlist/not%20a%20ticker' });

      assert.equal(response.statusCode, 400);
      assert.equal(pg.queries.length, 0);
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
