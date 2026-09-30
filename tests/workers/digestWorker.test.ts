import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import type { MailMessage } from '../../src/services/mailer.ts';
import { createDigestWorker } from '../../src/workers/digestWorker.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';
import { fakeRedis, type FakeRedis } from '../helpers/redis.ts';
import { jsonResponse, stubFetch, type FetchStub } from '../helpers/fetch.ts';

const brapiDefaults = { ...config.brapi };
const digestDefaults = { ...config.digest };

const NOW = new Date('2026-09-28T21:00:00.000Z'); // 18:00 in São Paulo
const PRICES: Record<string, number> = { PETR4: 41, VALE3: 59.4 };

function recipient(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    email: 'trader@example.test',
    digest_frequency: 'daily',
    digest_last_sent_at: new Date('2026-09-27T21:00:00.000Z'),
    ...overrides,
  };
}

function silentLogger() {
  const errors: object[] = [];
  return {
    errors,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: (obj: object) => void errors.push(obj) },
  };
}

/** Answers the lock, the recipient scan and each owner's watchlist. */
function wire(
  pg: FakePool,
  http: FetchStub,
  {
    locked = true,
    recipients = [recipient()],
    watchlist = [
      { symbol: 'PETR4', previous_price: '40.000000' },
      { symbol: 'VALE3', previous_price: null },
    ],
  }: { locked?: boolean; recipients?: object[]; watchlist?: object[] } = {},
) {
  pg.handle((sql) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
    if (sql.includes('FROM users')) return { rows: recipients };
    if (sql.includes('FROM watchlist')) return { rows: watchlist };
    return { rows: [], rowCount: 1 };
  });
  http.handle((url) => {
    const symbol = Object.keys(PRICES).find((candidate) => url.includes(candidate)) ?? 'PETR4';
    return jsonResponse({ results: [{ symbol, regularMarketPrice: PRICES[symbol] }] });
  });
}

function recordingSend() {
  const sent: MailMessage[] = [];
  return { sent, send: async (message: MailMessage) => void sent.push(message) };
}

describe('workers/digestWorker', () => {
  let pg: FakePool;
  let redis: FakeRedis;
  let http: FetchStub;

  beforeEach(() => {
    Object.assign(config.brapi, { baseUrl: 'https://brapi.test/api', token: null, retryBaseDelayMs: 1 });
    Object.assign(config.digest, { sendHour: 18, timeZone: 'America/Sao_Paulo' });
    pg = fakePool();
    redis = fakeRedis();
    redis.setReady(false);
    http = stubFetch();
  });

  afterEach(() => {
    http.restore();
    redis.restore();
    pg.restore();
    Object.assign(config.brapi, brapiDefaults);
    Object.assign(config.digest, digestDefaults);
  });

  it('emails a due user their watchlist and records the prices it sent', async () => {
    wire(pg, http);
    const { sent, send } = recordingSend();

    await createDigestWorker(silentLogger().logger, { send, now: () => NOW }).runOnce();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, 'trader@example.test');
    assert.match(sent[0]?.text ?? '', /PETR4\s+41\.00\s+\+2\.50%/);
    assert.match(sent[0]?.text ?? '', /VALE3\s+59\.40\s+new/);

    const recorded = queryMatching(pg.queries, 'INSERT INTO digest_prices');
    assert.ok(recorded, 'the send was not recorded, so it would repeat on the next check');
    assert.deepEqual(recorded.params, [42, ['PETR4', 'VALE3'], [41, 59.4], NOW], 'sent time must come from the same clock as the due check');
  });

  it('skips a user whose summary already went out today', async () => {
    wire(pg, http, { recipients: [recipient({ digest_last_sent_at: new Date('2026-09-28T21:00:00.000Z') })] });
    const { sent, send } = recordingSend();

    await createDigestWorker(silentLogger().logger, { send, now: () => NOW }).runOnce();

    assert.equal(sent.length, 0);
    assert.equal(queryMatching(pg.queries, 'FROM watchlist'), undefined, 'a user who is not due was still loaded');
  });

  it('sends nothing before the send hour', async () => {
    wire(pg, http);
    const { sent, send } = recordingSend();

    await createDigestWorker(silentLogger().logger, { send, now: () => new Date('2026-09-28T20:00:00.000Z') }).runOnce();

    assert.equal(sent.length, 0);
  });

  it('does not send or record an empty watchlist', async () => {
    wire(pg, http, { watchlist: [] });
    const { sent, send } = recordingSend();

    await createDigestWorker(silentLogger().logger, { send, now: () => NOW }).runOnce();

    assert.equal(sent.length, 0);
    assert.equal(queryMatching(pg.queries, 'INSERT INTO digest_prices'), undefined);
  });

  it('logs a failed send, leaves it unrecorded and carries on with the next user', async () => {
    wire(pg, http, {
      recipients: [recipient({ id: '1', email: 'broken@example.test' }), recipient({ id: '2' })],
    });
    const sent: MailMessage[] = [];
    const send = async (message: MailMessage) => {
      if (message.to === 'broken@example.test') throw new Error('mailbox unavailable');
      sent.push(message);
    };
    const { logger, errors } = silentLogger();

    await createDigestWorker(logger, { send, now: () => NOW }).runOnce();

    assert.equal(errors.length, 1);
    assert.equal(sent.length, 1, 'the second user was not reached');
    const recorded = pg.queries.filter((query) => query.sql.includes('INSERT INTO digest_prices'));
    assert.deepEqual(recorded.map((query) => query.params[0]), [2], 'only the delivered summary is recorded');
  });

  it('does nothing when another instance holds the lock', async () => {
    wire(pg, http, { locked: false });
    const { sent, send } = recordingSend();

    await createDigestWorker(silentLogger().logger, { send, now: () => NOW }).runOnce();

    assert.equal(sent.length, 0);
    assert.equal(queryMatching(pg.queries, 'FROM users'), undefined);
    assert.equal(pg.releaseCount, 1);
  });

  it('claims its own lock, not the alert poller\'s', async () => {
    wire(pg, http);

    await createDigestWorker(silentLogger().logger, { send: recordingSend().send, now: () => NOW }).runOnce();

    const lock = queryMatching(pg.queries, 'pg_try_advisory_lock');
    assert.equal(lock?.params[0], config.digest.lockKey);
    assert.notEqual(config.digest.lockKey, config.alerts.lockKey);
  });
});
