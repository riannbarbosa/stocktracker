import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import { createAlertPoller } from '../../src/workers/alertPoller.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';
import { fakeRedis, type FakeRedis } from '../helpers/redis.ts';
import { jsonResponse, stubFetch, type FetchStub } from '../helpers/fetch.ts';

const brapiDefaults = { ...config.brapi };
const notificationDefaults = { ...config.notifications };

const WEBHOOK = 'https://hooks.test/alert';

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    symbol: 'PETR4',
    direction: 'above',
    target_price: '30',
    webhook_url: WEBHOOK,
    email: null,
    active: true,
    fired_at: null,
    last_price: null,
    last_checked_at: null,
    created_at: new Date('2026-09-04T20:06:00.000Z'),
    updated_at: new Date('2026-09-04T20:06:00.000Z'),
    ...overrides,
  };
}

function silentLogger() {
  const errors: object[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: (obj: object) => void errors.push(obj),
    },
  };
}

/** Answers the lock, the active-alert scan and the unlock; price is the market. */
function wire(pg: FakePool, http: FetchStub, { locked = true, rows = [alertRow()], price = 31 } = {}) {
  pg.handle((sql) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
    if (sql.includes('FROM alerts')) return { rows };
    return { rows: [], rowCount: 1 };
  });
  http.handle((url) =>
    url.startsWith(config.brapi.baseUrl)
      ? jsonResponse({ results: [{ symbol: 'PETR4', regularMarketPrice: price }] })
      : jsonResponse({ ok: true }),
  );
}

describe('workers/alertPoller', () => {
  let pg: FakePool;
  let redis: FakeRedis;
  let http: FetchStub;

  beforeEach(() => {
    Object.assign(config.brapi, { baseUrl: 'https://brapi.test/api', token: null, retryBaseDelayMs: 1 });
    Object.assign(config.notifications, { webhookAllowedHosts: ['hooks.test'] });
    pg = fakePool();
    redis = fakeRedis();
    /* The poller reuses the quote cache; keeping it down forces the brapi path. */
    redis.setReady(false);
    http = stubFetch();
  });

  afterEach(() => {
    http.restore();
    redis.restore();
    pg.restore();
    Object.assign(config.brapi, brapiDefaults);
    Object.assign(config.notifications, notificationDefaults);
  });

  describe('advisory lock', () => {
    /* pg_try_advisory_lock() takes a bigint. Handing it the readable env string
     * makes Postgres raise `invalid input syntax for type bigint`, which the
     * cycle's own catch swallows — the poller then runs forever doing nothing. */
    it('claims the lock with a bigint-compatible key', async () => {
      wire(pg, http);

      await createAlertPoller(silentLogger().logger).runOnce();

      const lock = queryMatching(pg.queries, 'pg_try_advisory_lock');
      assert.ok(lock, 'the cycle never reached the lock');
      assert.equal(typeof lock.params[0], 'number');
      assert.ok(Number.isInteger(lock.params[0]), 'a fractional key would not bind to bigint either');
    });

    it('logs nothing and does no work when the key is rejected', async () => {
      wire(pg, http);
      const { logger, errors } = silentLogger();

      await createAlertPoller(logger).runOnce();

      assert.deepEqual(errors, [], 'a healthy cycle reports no error');
    });

    it('skips the cycle when another instance holds the lock', async () => {
      wire(pg, http, { locked: false });

      await createAlertPoller(silentLogger().logger).runOnce();

      assert.equal(queryMatching(pg.queries, 'FROM alerts'), undefined, 'no alert was scanned');
      assert.equal(http.calls.length, 0, 'nothing was fetched or notified');
    });

    it('releases the client even when it skips', async () => {
      wire(pg, http, { locked: false });

      await createAlertPoller(silentLogger().logger).runOnce();

      assert.equal(pg.releaseCount, 1);
    });

    it('unlocks and releases after a completed cycle', async () => {
      wire(pg, http);

      await createAlertPoller(silentLogger().logger).runOnce();

      assert.ok(queryMatching(pg.queries, 'pg_advisory_unlock'), 'the lock was not given back');
      assert.equal(pg.releaseCount, 1);
    });
  });

  describe('a crossing alert', () => {
    it('marks it fired and delivers the webhook', async () => {
      wire(pg, http, { price: 31 });

      await createAlertPoller(silentLogger().logger).runOnce();

      const update = queryMatching(pg.queries, 'fired_at = now()');
      assert.ok(update, 'fired_at was never set, so it would notify again next cycle');
      assert.deepEqual(update.params, [1, 31]);

      const delivered = http.calls.filter((call) => call.url === WEBHOOK);
      assert.equal(delivered.length, 1);
    });
  });

  describe('an alert that has not crossed', () => {
    it('only records the observed price', async () => {
      wire(pg, http, { price: 29 });

      await createAlertPoller(silentLogger().logger).runOnce();

      assert.equal(queryMatching(pg.queries, 'fired_at = now()'), undefined);
      assert.equal(http.calls.filter((call) => call.url === WEBHOOK).length, 0);
      assert.ok(queryMatching(pg.queries, 'last_checked_at = now()'), 'the poll was not recorded');
    });
  });

  describe('an alert that already fired', () => {
    it('re-arms once the price crosses back, without notifying', async () => {
      wire(pg, http, { rows: [alertRow({ fired_at: new Date('2026-09-04T21:00:00.000Z') })], price: 29 });

      await createAlertPoller(silentLogger().logger).runOnce();

      const rearm = queryMatching(pg.queries, 'fired_at = NULL');
      assert.ok(rearm, 'the alert stays latched and can never fire again');
      assert.equal(http.calls.filter((call) => call.url === WEBHOOK).length, 0);
    });
  });

  describe('resilience', () => {
    it('reports a failed cycle instead of throwing out of the interval', async () => {
      pg.failConnect(new Error('pool exhausted'));
      const { logger, errors } = silentLogger();

      await assert.doesNotReject(createAlertPoller(logger).runOnce());
      assert.equal(errors.length, 1);
    });

    it('recovers on the next cycle after a failure', async () => {
      pg.failConnect(new Error('pool exhausted'));
      const poller = createAlertPoller(silentLogger().logger);
      await poller.runOnce();

      pg.failConnect(null as unknown as Error);
      wire(pg, http);
      await poller.runOnce();

      assert.ok(queryMatching(pg.queries, 'pg_try_advisory_lock'), 'the poller stayed wedged');
    });
  });
});
