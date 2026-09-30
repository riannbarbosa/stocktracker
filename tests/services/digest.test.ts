import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDigestEmail, isDigestDue, localClock } from '../../src/services/digest.ts';

/* America/Sao_Paulo is UTC-3 with no DST, so 21:00Z is 18:00 local. */
const SCHEDULE = { sendHour: 18, timeZone: 'America/Sao_Paulo' };
const NOW = new Date('2026-09-28T21:00:00.000Z'); // Mon 28 Sep, 18:00 local

describe('services/digest', () => {
  describe('localClock', () => {
    it('reads the date and hour in the given zone', () => {
      assert.deepEqual(localClock(NOW, SCHEDULE.timeZone), { date: '2026-09-28', hour: 18 });
    });

    it('reports local midnight as hour 0, not 24', () => {
      assert.deepEqual(localClock(new Date('2026-09-28T03:00:00.000Z'), SCHEDULE.timeZone), {
        date: '2026-09-28',
        hour: 0,
      });
    });
  });

  describe('isDigestDue', () => {
    it('never sends when the digest is off', () => {
      assert.equal(isDigestDue('off', null, NOW, SCHEDULE), false);
    });

    it('waits for the send hour, even for a first summary', () => {
      const beforeHour = new Date('2026-09-28T20:59:00.000Z'); // 17:59 local
      assert.equal(isDigestDue('daily', null, beforeHour, SCHEDULE), false);
      assert.equal(isDigestDue('daily', null, NOW, SCHEDULE), true);
    });

    describe('daily', () => {
      it('is due when the last one went out on an earlier local day', () => {
        const yesterday = '2026-09-27T21:10:00.000Z';
        assert.equal(isDigestDue('daily', yesterday, NOW, SCHEDULE), true);
      });

      it('is not due twice on the same local day', () => {
        const earlierToday = '2026-09-28T21:00:00.000Z';
        const later = new Date('2026-09-29T02:00:00.000Z'); // 23:00 local, same day
        assert.equal(isDigestDue('daily', earlierToday, later, SCHEDULE), false);
      });

      /* 01:00Z on the 28th is 22:00 on the 27th in São Paulo. Comparing UTC
       * dates would call it "today" and skip the 28th's summary. */
      it('compares local dates, not UTC dates', () => {
        const lateLocalEvening = '2026-09-28T01:00:00.000Z';
        assert.equal(isDigestDue('daily', lateLocalEvening, NOW, SCHEDULE), true);
      });
    });

    describe('weekly', () => {
      it('is not due after six days', () => {
        assert.equal(isDigestDue('weekly', '2026-09-22T21:00:00.000Z', NOW, SCHEDULE), false);
      });

      it('is due after seven days, whatever the hour of the last send', () => {
        assert.equal(isDigestDue('weekly', '2026-09-21T23:30:00.000Z', NOW, SCHEDULE), true);
      });
    });

    describe('monthly', () => {
      it('is due on the first day of a new month', () => {
        const lastDayOfAugust = '2026-08-31T21:00:00.000Z';
        const firstOfSeptember = new Date('2026-09-01T21:00:00.000Z');
        assert.equal(isDigestDue('monthly', lastDayOfAugust, firstOfSeptember, SCHEDULE), true);
      });

      it('is not due again within the same month', () => {
        assert.equal(isDigestDue('monthly', '2026-09-01T21:00:00.000Z', NOW, SCHEDULE), false);
      });
    });
  });

  describe('buildDigestEmail', () => {
    const items = [
      { symbol: 'PETR4', price: 41, previousPrice: 40 },
      { symbol: 'VALE3', price: 59.4, previousPrice: 60 },
      { symbol: 'ITUB4', price: 33.1, previousPrice: null },
      { symbol: 'BBAS3', price: null, previousPrice: 27 },
    ];

    it('names the frequency and the ticker count in the subject', () => {
      assert.equal(buildDigestEmail('weekly', items).subject, 'Your weekly watchlist summary (4 tickers)');
      assert.equal(buildDigestEmail('daily', items.slice(0, 1)).subject, 'Your daily watchlist summary (1 ticker)');
    });

    it('lists every ticker with its change since the previous summary', () => {
      const lines = buildDigestEmail('daily', items).text.split('\n');
      const line = (symbol: string) => lines.find((entry) => entry.startsWith(symbol)) ?? '';

      assert.match(line('PETR4'), /41\.00\s+\+2\.50%$/);
      assert.match(line('VALE3'), /59\.40\s+-1\.00%$/);
      assert.match(line('ITUB4'), /33\.10\s+new$/, 'a first appearance has nothing to compare to');
      assert.match(line('BBAS3'), /price unavailable$/);
    });
  });
});
