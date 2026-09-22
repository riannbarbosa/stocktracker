import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import { buildPayload, notifyAlert } from '../../src/services/notifier.ts';
import { jsonResponse, stubFetch, type FetchStub } from '../helpers/fetch.ts';
import type { Alert } from '../../src/types/alerts.ts';

const notificationDefaults = { ...config.notifications };

interface LogEntry {
  obj: object;
  msg?: string;
}

function recordingLogger() {
  const info: LogEntry[] = [];
  const warn: LogEntry[] = [];
  const error: LogEntry[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      info: (obj: object, msg?: string) => void info.push({ obj, msg }),
      warn: (obj: object, msg?: string) => void warn.push({ obj, msg }),
      error: (obj: object, msg?: string) => void error.push({ obj, msg }),
    },
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 7,
    symbol: 'PETR4',
    direction: 'above',
    targetPrice: 30,
    webhookUrl: null,
    email: null,
    active: true,
    firedAt: null,
    lastPrice: null,
    lastCheckedAt: null,
    createdAt: '2026-09-04T20:06:00.000Z',
    updatedAt: '2026-09-04T20:06:00.000Z',
    ...overrides,
  };
}

describe('services/notifier', () => {
  let http: FetchStub;

  beforeEach(() => {
    /* hooks.test does not resolve, so it goes through the operator allowlist —
     * the supported way to point a webhook at a host the range check would
     * otherwise reject. */
    Object.assign(config.notifications, {
      webhookTimeoutMs: 1000,
      smtpUrl: null,
      webhookAllowedHosts: ['hooks.test'],
    });
    http = stubFetch();
  });

  afterEach(() => {
    http.restore();
    Object.assign(config.notifications, notificationDefaults);
  });

  describe('buildPayload', () => {
    it('describes the crossing that fired', () => {
      const payload = buildPayload(alert({ direction: 'below', targetPrice: 25 }), 24.5);

      assert.equal(payload.event, 'alert.triggered');
      assert.equal(payload.alertId, 7);
      assert.equal(payload.symbol, 'PETR4');
      assert.equal(payload.direction, 'below');
      assert.equal(payload.targetPrice, 25);
      assert.equal(payload.price, 24.5);
      assert.ok(!Number.isNaN(Date.parse(payload.triggeredAt)), 'triggeredAt is an ISO timestamp');
    });
  });

  describe('webhook delivery', () => {
    it('POSTs the payload as JSON', async () => {
      http.reply({ ok: true });
      const { logger, info } = recordingLogger();

      await notifyAlert(alert({ webhookUrl: 'https://hooks.test/alert' }), 31, logger);

      assert.equal(http.calls.length, 1);
      assert.equal(http.calls[0]?.url, 'https://hooks.test/alert');
      assert.equal(http.calls[0]?.headers.get('content-type'), 'application/json');
      assert.equal(info.length, 1, 'a delivered alert is logged once');
    });

    it('logs and swallows a non-2xx response so the poll cycle survives', async () => {
      http.handle(() => jsonResponse({ error: 'nope' }, 500));
      const { logger, error, info } = recordingLogger();

      await notifyAlert(alert({ webhookUrl: 'https://hooks.test/alert' }), 31, logger);

      assert.equal(error.length, 1);
      assert.match(String((error[0]?.obj as { err?: unknown }).err), /500/);
      assert.equal(info.length, 1, 'delivery is still reported as attempted');
    });

    it('does not throw when the request itself fails', async () => {
      http.handle(() => {
        throw new Error('socket hang up');
      });
      const { logger, error } = recordingLogger();

      await assert.doesNotReject(
        notifyAlert(alert({ webhookUrl: 'https://hooks.test/alert' }), 31, logger),
      );
      assert.equal(error.length, 1);
    });
  });

  describe('email delivery', () => {
    it('reports a misconfigured SMTP url instead of throwing', async () => {
      config.notifications.smtpUrl = null;
      const { logger, error } = recordingLogger();

      await notifyAlert(alert({ email: 'trader@example.test' }), 31, logger);

      assert.equal(http.calls.length, 0, 'no webhook is attempted');
      assert.equal(error.length, 1);
      assert.match(String((error[0]?.obj as { err?: unknown }).err), /SMTP/i);
    });
  });

  describe('no channel', () => {
    it('warns and sends nothing when the alert has neither channel', async () => {
      const { logger, warn, info } = recordingLogger();

      await notifyAlert(alert(), 31, logger);

      assert.equal(http.calls.length, 0);
      assert.equal(warn.length, 1);
      assert.equal(info.length, 0, 'nothing was delivered, so nothing is reported as notified');
    });
  });
});
