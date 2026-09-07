import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import { BrapiError, fetchStockQuotes } from '../../src/services/brapi.ts';
import { jsonResponse, stubFetch, type FetchStub } from '../helpers/fetch.ts';
import type { BrapiQuote } from '../../src/types/brapi.ts';

const brapiDefaults = { ...config.brapi };

const FULL_QUOTE: BrapiQuote = {
  symbol: 'petr4',
  shortName: 'PETROBRAS PN',
  longName: 'Petroleo Brasileiro S.A. - Petrobras',
  currency: 'BRL',
  regularMarketPrice: 38.42,
  regularMarketChange: -0.58,
  regularMarketChangePercent: -1.49,
  regularMarketDayHigh: 39.1,
  regularMarketDayLow: 38.05,
  regularMarketVolume: 27_450_100,
  regularMarketTime: '2026-09-04T20:06:00.000Z',
  marketCap: 495_000_000_000,
  logourl: 'https://brapi.dev/logos/PETR4.png',
};

function results(...quotes: BrapiQuote[]): { results: BrapiQuote[] } {
  return { results: quotes };
}

describe('services/brapi', () => {
  let http: FetchStub;

  beforeEach(() => {
    Object.assign(config.brapi, {
      baseUrl: 'https://brapi.test/api/v2',
      token: null,
      timeoutMs: 1000,
      retryCount: 3,
      retryBaseDelayMs: 1,
    });
    http = stubFetch();
  });

  afterEach(() => {
    http.restore();
    Object.assign(config.brapi, brapiDefaults);
  });

  describe('normalization', () => {
    it('maps a brapi quote onto the shape this API serves', async () => {
      http.reply(results(FULL_QUOTE));

      const [quote] = await fetchStockQuotes(['petr4']);

      assert.ok(quote);
      assert.equal(quote.symbol, 'PETR4', 'symbols are upper-cased');
      assert.equal(quote.name, 'PETROBRAS PN');
      assert.equal(quote.currency, 'BRL');
      assert.equal(quote.price, 38.42);
      assert.equal(quote.dayHigh, 39.1);
      assert.equal(quote.dayLow, 38.05);
      assert.equal(quote.change, -0.58);
      assert.equal(quote.changePercent, -1.49);
      assert.equal(quote.time, '2026-09-04T20:06:00.000Z');
      assert.equal(quote.marketCap, 495_000_000_000);
      assert.equal(quote.volume, 27_450_100);
      assert.equal(quote.logoUrl, 'https://brapi.dev/logos/PETR4.png');
      assert.equal(quote.fetchedAt, new Date(quote.fetchedAt).toISOString());
    });

    it('falls back to longName when shortName is absent', async () => {
      http.reply(results({ symbol: 'VALE3', longName: 'Vale S.A.' }));

      const [quote] = await fetchStockQuotes(['VALE3']);

      assert.equal(quote?.name, 'Vale S.A.');
    });

    it('nulls out every optional field brapi omits', async () => {
      http.reply(results({ symbol: 'ITUB4' }));

      const [quote] = await fetchStockQuotes(['ITUB4']);

      assert.ok(quote);
      const { symbol, fetchedAt, ...optional } = quote;
      assert.equal(symbol, 'ITUB4');
      assert.ok(fetchedAt);
      assert.deepEqual(
        Object.values(optional).filter((value) => value !== null),
        [],
        'missing brapi fields become null rather than undefined',
      );
    });
  });

  describe('requests', () => {
    it('hits the configured base url with a url-encoded symbol', async () => {
      http.reply(results({ symbol: 'PETR4' }));

      await fetchStockQuotes(['PETR4/../admin']);

      assert.equal(http.calls[0]?.url, 'https://brapi.test/api/v2/quote/PETR4%2F..%2Fadmin');
    });

    it('asks for json and sends no authorization header without a token', async () => {
      http.reply(results({ symbol: 'PETR4' }));

      await fetchStockQuotes(['PETR4']);

      assert.equal(http.calls[0]?.headers.get('accept'), 'application/json');
      assert.equal(http.calls[0]?.headers.get('authorization'), null);
    });

    it('sends the bearer token when one is configured', async () => {
      config.brapi.token = 's3cret';
      http.reply(results({ symbol: 'PETR4' }));

      await fetchStockQuotes(['PETR4']);

      assert.equal(http.calls[0]?.headers.get('authorization'), 'Bearer s3cret');
    });

    it('resolves one quote per requested symbol, in request order', async () => {
      const prices: Record<string, number> = { PETR4: 38.42, VALE3: 54.1, ITUB4: 32.77 };
      http.handle((url) => {
        const symbol = decodeURIComponent(url.split('/').pop() ?? '');
        return jsonResponse(results({ symbol, regularMarketPrice: prices[symbol] }));
      });

      const quotes = await fetchStockQuotes(['PETR4', 'VALE3', 'ITUB4']);

      assert.deepEqual(
        quotes.map((quote) => [quote.symbol, quote.price]),
        [['PETR4', 38.42], ['VALE3', 54.1], ['ITUB4', 32.77]],
      );
      assert.equal(http.calls.length, 3);
    });
  });

  describe('errors', () => {
    it('raises a 404 BrapiError when the provider does not know the symbol', async () => {
      http.reply({ error: true }, 404);

      await assert.rejects(fetchStockQuotes(['XXXX9']), (error: unknown) => {
        assert.ok(error instanceof BrapiError);
        assert.equal(error.name, 'BrapiError');
        assert.equal(error.status, 404);
        assert.equal(error.message, 'Unknown symbol: XXXX9');
        return true;
      });
      assert.equal(http.calls.length, 1, '404 is not retried');
    });

    it('raises a 404 BrapiError when the provider returns no results', async () => {
      http.reply(results());

      await assert.rejects(fetchStockQuotes(['XXXX9']), (error: unknown) => {
        assert.ok(error instanceof BrapiError);
        assert.equal(error.status, 404);
        return true;
      });
    });

    it('retries 5xx up to retryCount and then surfaces the failure', async () => {
      http.reply({ error: 'boom' }, 503);

      await assert.rejects(fetchStockQuotes(['PETR4']), (error: unknown) => {
        assert.ok(error instanceof BrapiError);
        assert.equal(error.status, 503);
        assert.equal(error.message, 'brapi responded 503 for PETR4');
        return true;
      });
      assert.equal(http.calls.length, config.brapi.retryCount);
    });

    it('recovers when a retried request succeeds', async () => {
      http.replyEach([
        { status: 500 },
        { status: 429 },
        { body: results({ symbol: 'PETR4', regularMarketPrice: 38.42 }) },
      ]);

      const [quote] = await fetchStockQuotes(['PETR4']);

      assert.equal(quote?.price, 38.42);
      assert.equal(http.calls.length, 3);
    });

    it('does not retry client errors other than 429', async () => {
      http.reply({ error: 'bad request' }, 400);

      await assert.rejects(fetchStockQuotes(['PETR4']));
      assert.equal(http.calls.length, 1);
    });

    it('rejects the whole batch when one symbol fails', async () => {
      http.handle((url) =>
        url.endsWith('VALE3')
          ? jsonResponse({ error: true }, 404)
          : jsonResponse(results({ symbol: 'PETR4' })),
      );

      await assert.rejects(fetchStockQuotes(['PETR4', 'VALE3']), BrapiError);
    });
  });
});
