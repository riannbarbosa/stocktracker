import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import { BrapiError } from '../../src/services/brapi.ts';
import { getStockQuotes, invalidateQuote } from '../../src/services/quotes.ts';
import { fakeRedis, type FakeRedis } from '../helpers/redis.ts';
import { jsonResponse, stubFetch, type FetchStub } from '../helpers/fetch.ts';
import type { StockQuote } from '../../src/types/brapi.ts';

const brapiDefaults = { ...config.brapi };
const quotesDefaults = { ...config.quotes };

interface LogEntry {
  obj: object;
  msg?: string;
}

function recordingLogger() {
  const debug: LogEntry[] = [];
  const warn: LogEntry[] = [];
  return {
    debug,
    warn,
    logger: {
      debug: (obj: object, msg?: string) => void debug.push({ obj, msg }),
      warn: (obj: object, msg?: string) => void warn.push({ obj, msg }),
    },
  };
}

function cached(symbol: string, price: number): StockQuote {
  return {
    symbol,
    name: `${symbol} SA`,
    currency: 'BRL',
    price,
    dayHigh: price + 1,
    dayLow: price - 1,
    change: 0.1,
    changePercent: 0.26,
    time: '2026-09-04T20:06:00.000Z',
    marketCap: 1_000,
    volume: 2_000,
    logoUrl: null,
    fetchedAt: '2026-09-04T20:06:30.000Z',
  };
}

function symbolOf(url: string): string {
  return decodeURIComponent(url.split('/').pop() ?? '');
}

describe('services/quotes', () => {
  let redis: FakeRedis;
  let http: FetchStub;
  let log: ReturnType<typeof recordingLogger>;

  beforeEach(() => {
    Object.assign(config.brapi, {
      baseUrl: 'https://brapi.test/api/v2',
      token: null,
      timeoutMs: 1000,
      retryCount: 1,
      retryBaseDelayMs: 1,
    });
    Object.assign(config.quotes, { cachePrefix: 'test:quote:', cacheTtlSeconds: 42 });

    redis = fakeRedis();
    http = stubFetch();
    /* brapi answers with a live price of 100 for whatever symbol is asked for,
     * so cached (price 10) and freshly fetched quotes are told apart by value. */
    http.handle((url) =>
      jsonResponse({ results: [{ symbol: symbolOf(url), shortName: 'Fresh', regularMarketPrice: 100 }] }),
    );
    log = recordingLogger();
  });

  afterEach(() => {
    http.restore();
    redis.restore();
    Object.assign(config.brapi, brapiDefaults);
    Object.assign(config.quotes, quotesDefaults);
  });

  describe('getStockQuotes', () => {
    it('returns an empty lookup without touching redis or brapi', async () => {
      const result = await getStockQuotes([], { logger: log.logger });

      assert.deepEqual(result, { quotes: [], cacheHits: [], cacheMisses: [] });
      assert.equal(redis.mGetCalls.length, 0);
      assert.equal(http.calls.length, 0);
    });

    it('upper-cases, trims and dedupes the requested symbols', async () => {
      await getStockQuotes([' petr4 ', 'PETR4', 'vale3', ''], { logger: log.logger });

      assert.deepEqual(redis.mGetCalls[0], ['test:quote:PETR4', 'test:quote:VALE3']);
      assert.deepEqual(http.calls.map((call) => symbolOf(call.url)), ['PETR4', 'VALE3']);
    });

    it('serves cached symbols without calling brapi', async () => {
      redis.stored.set('test:quote:PETR4', JSON.stringify(cached('PETR4', 10)));
      redis.stored.set('test:quote:VALE3', JSON.stringify(cached('VALE3', 20)));

      const result = await getStockQuotes(['PETR4', 'VALE3'], { logger: log.logger });

      assert.equal(http.calls.length, 0);
      assert.deepEqual(result.cacheHits, ['PETR4', 'VALE3']);
      assert.deepEqual(result.cacheMisses, []);
      assert.deepEqual(result.quotes.map((quote) => quote.price), [10, 20]);
      assert.equal(redis.execCount, 0, 'nothing to write back');
    });

    it('fetches only the missing symbols and keeps the requested order', async () => {
      redis.stored.set('test:quote:VALE3', JSON.stringify(cached('VALE3', 20)));

      const result = await getStockQuotes(['PETR4', 'VALE3', 'ITUB4'], { logger: log.logger });

      assert.deepEqual(http.calls.map((call) => symbolOf(call.url)), ['PETR4', 'ITUB4']);
      assert.deepEqual(result.cacheHits, ['VALE3']);
      assert.deepEqual(result.cacheMisses, ['PETR4', 'ITUB4']);
      assert.deepEqual(
        result.quotes.map((quote) => [quote.symbol, quote.price]),
        [['PETR4', 100], ['VALE3', 20], ['ITUB4', 100]],
      );
    });

    it('writes fetched quotes back under the configured prefix and ttl', async () => {
      await getStockQuotes(['PETR4'], { logger: log.logger });

      assert.equal(redis.setCalls.length, 1);
      const [write] = redis.setCalls;
      assert.equal(write?.key, 'test:quote:PETR4');
      assert.deepEqual(write?.options, { EX: 42 });
      assert.equal((JSON.parse(write?.value ?? 'null') as StockQuote).symbol, 'PETR4');
      assert.equal(redis.execCount, 1, 'the write-back is a single transaction');
    });

    it('treats a poisoned cache entry as a miss', async () => {
      redis.stored.set('test:quote:PETR4', '{not json');

      const result = await getStockQuotes(['PETR4'], { logger: log.logger });

      assert.deepEqual(result.cacheMisses, ['PETR4']);
      assert.equal(result.quotes[0]?.price, 100, 'the entry is refetched');
      assert.equal(redis.setCalls[0]?.key, 'test:quote:PETR4', 'and overwritten');
    });

    it('falls through to brapi when the cache read fails', async () => {
      redis.failMGet(new Error('CONNECTION_BROKEN'));

      const result = await getStockQuotes(['PETR4'], { logger: log.logger });

      assert.equal(result.quotes[0]?.price, 100);
      assert.deepEqual(result.cacheMisses, ['PETR4']);
      assert.match(log.warn[0]?.msg ?? '', /cache read failed/);
    });

    it('still answers when the cache write fails', async () => {
      redis.failExec(new Error('READONLY'));

      const result = await getStockQuotes(['PETR4'], { logger: log.logger });

      assert.equal(result.quotes[0]?.price, 100);
      assert.match(log.warn[0]?.msg ?? '', /failed to write stock quotes to cache/);
    });

    it('skips the cache entirely while redis is down', async () => {
      redis.setReady(false);

      const result = await getStockQuotes(['PETR4'], { logger: log.logger });

      assert.equal(redis.mGetCalls.length, 0);
      assert.equal(redis.execCount, 0);
      assert.deepEqual(result.cacheMisses, ['PETR4']);
      assert.equal(result.quotes[0]?.price, 100);
    });

    it('propagates a provider error instead of returning a partial answer', async () => {
      http.handle((url) =>
        symbolOf(url) === 'XXXX9'
          ? jsonResponse({ error: true }, 404)
          : jsonResponse({ results: [{ symbol: symbolOf(url) }] }),
      );

      await assert.rejects(getStockQuotes(['PETR4', 'XXXX9'], { logger: log.logger }), BrapiError);
      assert.equal(redis.execCount, 0, 'nothing is cached when the batch fails');
    });

    it('works without a logger', async () => {
      const result = await getStockQuotes(['PETR4'], {});

      assert.equal(result.quotes.length, 1);
    });
  });

  describe('invalidateQuote', () => {
    it('deletes the prefixed key', async () => {
      await invalidateQuote('PETR4');

      assert.deepEqual(redis.delCalls, ['test:quote:PETR4']);
    });

    it('does nothing while redis is down', async () => {
      redis.setReady(false);

      await invalidateQuote('PETR4');

      assert.deepEqual(redis.delCalls, []);
    });

    it('swallows redis failures', async () => {
      redis.failDel(new Error('CONNECTION_BROKEN'));

      await assert.doesNotReject(invalidateQuote('PETR4'));
    });
  });
});
