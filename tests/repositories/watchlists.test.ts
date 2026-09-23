import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { addToWatchlist, listWatchlist, removeFromWatchlist } from '../../src/repositories/watchlists.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';

const OWNER_ID = 42;

const ROW = {
  id: '3',
  symbol: 'PETR4',
  owner_id: '42',
  created_at: new Date('2026-09-04T20:06:00.000Z'),
};

describe('repositories/watchlists', () => {
  let pg: FakePool;

  beforeEach(() => {
    pg = fakePool();
  });

  afterEach(() => {
    pg.restore();
  });

  /* schema.sql creates the table as `watchlist`, singular. Querying `watchlists`
   * fails with `relation "watchlists" does not exist`, which only shows up at
   * runtime, so every statement is pinned here. */
  it('targets the table name that schema.sql actually creates', async () => {
    pg.results([{ rows: [ROW] }, { rows: [ROW] }, { rowCount: 1 }]);

    await listWatchlist(OWNER_ID);
    await addToWatchlist(OWNER_ID, 'PETR4');
    await removeFromWatchlist(OWNER_ID, 'PETR4');

    assert.equal(pg.queries.length, 3);
    for (const { sql } of pg.queries) {
      assert.ok(!sql.includes('watchlists'), `statement still says "watchlists": ${sql}`);
      assert.ok(sql.includes('watchlist'), `statement does not touch the table: ${sql}`);
    }
  });

  describe('listWatchlist', () => {
    it('filters by owner and maps the row onto the served shape', async () => {
      pg.results([{ rows: [ROW] }]);

      const items = await listWatchlist(OWNER_ID);

      const query = queryMatching(pg.queries, 'SELECT');
      assert.deepEqual(query?.params, [OWNER_ID]);
      assert.deepEqual(items, [
        { id: 3, symbol: 'PETR4', ownerId: OWNER_ID, createdAt: '2026-09-04T20:06:00.000Z' },
      ]);
      assert.equal(typeof items[0]?.id, 'number', 'bigint ids come back from pg as strings');
    });

    it('returns an empty list when the owner tracks nothing', async () => {
      pg.results([{ rows: [] }]);
      assert.deepEqual(await listWatchlist(OWNER_ID), []);
    });
  });

  describe('addToWatchlist', () => {
    /* The bind order has to follow the column list. Passing [owner, symbol] to
     * `(symbol, owner) VALUES ($1, $2)` silently writes the owner into the
     * symbol column, and the row then never matches `WHERE owner = $1`. */
    it('binds the parameters in the order the column list declares', async () => {
      pg.results([{ rows: [ROW] }]);

      await addToWatchlist(OWNER_ID, 'PETR4');

      const query = queryMatching(pg.queries, 'INSERT INTO');
      assert.ok(query);
      assert.match(query.sql, /INSERT INTO watchlist \(symbol, owner_id\)/);
      assert.deepEqual(query.params, ['PETR4', OWNER_ID], 'symbol binds to $1, owner_id to $2');
    });

    it('upper-cases the ticker before storing it', async () => {
      pg.results([{ rows: [ROW] }]);

      await addToWatchlist(OWNER_ID, 'petr4');

      assert.deepEqual(queryMatching(pg.queries, 'INSERT INTO')?.params, ['PETR4', OWNER_ID]);
    });

    it('is idempotent: a conflicting insert still returns the row', async () => {
      pg.results([{ rows: [ROW] }]);

      const item = await addToWatchlist(OWNER_ID, 'PETR4');

      assert.match(queryMatching(pg.queries, 'INSERT INTO')!.sql, /ON CONFLICT \(symbol, owner_id\)/);
      assert.equal(item.symbol, 'PETR4');
    });
  });

  describe('removeFromWatchlist', () => {
    it('binds owner then symbol, matching its own where clause', async () => {
      pg.results([{ rowCount: 1 }]);

      const removed = await removeFromWatchlist(OWNER_ID, 'petr4');

      const query = queryMatching(pg.queries, 'DELETE FROM');
      assert.ok(query);
      assert.match(query.sql, /WHERE owner_id = \$1 AND symbol = \$2/);
      assert.deepEqual(query.params, [OWNER_ID, 'PETR4']);
      assert.equal(removed, true);
    });

    it('reports false when the ticker was not on the list', async () => {
      pg.results([{ rowCount: 0 }]);
      assert.equal(await removeFromWatchlist(OWNER_ID, 'PETR4'), false);
    });
  });
});
