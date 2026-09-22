import type { Alert } from '../types/alerts.ts';

export type AlertOutcome = 'trigger' | 'rearm' | 'noop';

/* Pure decision function — no I/O, so the whole fired-state rule is unit
 * testable without a database or a market feed.
 *
 *   armed  + condition met      -> trigger (notify once, set fired_at)
 *   fired  + condition no longer met -> rearm (clear fired_at, stay quiet)
 *   anything else               -> noop
 *
 * The re-arm branch is what stops a price hovering on the target from sending
 * a notification every poll interval. */
export function evaluateAlert(alert: Pick<Alert, 'direction' | 'targetPrice' | 'firedAt'>, price: number): AlertOutcome {
  const conditionMet = alert.direction === 'above'
    ? price >= alert.targetPrice
    : price <= alert.targetPrice;

  if (conditionMet && alert.firedAt === null) return 'trigger';
  if (!conditionMet && alert.firedAt !== null) return 'rearm';
  return 'noop';
}