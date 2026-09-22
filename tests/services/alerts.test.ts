import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateAlert } from '../../src/services/alerts.ts';
import type { Alert } from '../../src/types/alerts.ts';

type Decision = Pick<Alert, 'direction' | 'targetPrice' | 'firedAt'>;

function armed(direction: Alert['direction'], targetPrice: number): Decision {
  return { direction, targetPrice, firedAt: null };
}

function fired(direction: Alert['direction'], targetPrice: number): Decision {
  return { direction, targetPrice, firedAt: '2026-09-04T20:06:00.000Z' };
}

describe('services/alerts evaluateAlert', () => {
  describe("direction 'above'", () => {
    it('triggers once the price reaches the target', () => {
      assert.equal(evaluateAlert(armed('above', 30), 30.5), 'trigger');
    });

    it('treats the target itself as met (>=, not >)', () => {
      assert.equal(evaluateAlert(armed('above', 30), 30), 'trigger');
    });

    it('does nothing while the price is below the target', () => {
      assert.equal(evaluateAlert(armed('above', 30), 29.99), 'noop');
    });
  });

  describe("direction 'below'", () => {
    it('triggers once the price drops to the target', () => {
      assert.equal(evaluateAlert(armed('below', 30), 29.5), 'trigger');
    });

    it('treats the target itself as met (<=, not <)', () => {
      assert.equal(evaluateAlert(armed('below', 30), 30), 'trigger');
    });

    it('does nothing while the price is above the target', () => {
      assert.equal(evaluateAlert(armed('below', 30), 30.01), 'noop');
    });
  });

  describe('fired state', () => {
    /* This is the rule that stops a price hovering on the target from notifying
     * on every poll interval. */
    it('stays quiet while the condition is still met', () => {
      assert.equal(evaluateAlert(fired('above', 30), 31), 'noop');
      assert.equal(evaluateAlert(fired('below', 30), 29), 'noop');
    });

    it('re-arms once the price crosses back', () => {
      assert.equal(evaluateAlert(fired('above', 30), 29), 'rearm');
      assert.equal(evaluateAlert(fired('below', 30), 31), 'rearm');
    });

    it('can trigger again after re-arming', () => {
      const alert = fired('above', 30);
      assert.equal(evaluateAlert(alert, 29), 'rearm');
      /* markAlertRearmed() clears fired_at, which is what the next poll reads. */
      assert.equal(evaluateAlert({ ...alert, firedAt: null }, 31), 'trigger');
    });
  });

  it('never triggers twice for the same crossing', () => {
    const prices = [31, 32, 33];
    const outcomes = prices.map((price) => evaluateAlert(fired('above', 30), price));
    assert.deepEqual(outcomes, ['noop', 'noop', 'noop']);
  });
});
