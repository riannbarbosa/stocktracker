import { config } from "../config.ts";
import { assertWebhookAllowed } from '../lib/webhookUrl.ts';
import type { Alert } from '../types/alerts.ts';

interface Logger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface AlertPayload {
  event: 'alert.triggered';
  alertId: number;
  symbol: string;
  direction: Alert['direction'];
  targetPrice: number;
  price: number;
  triggeredAt: string;
}

export function buildPayload(alert: Alert, price: number): AlertPayload {
    return {
        event: 'alert.triggered',
        alertId: alert.id,
        symbol: alert.symbol,
        direction: alert.direction,
        targetPrice: alert.targetPrice,
        price,
        triggeredAt: new Date().toISOString(),
    };
}

async function sendWebhook(url: string, payload: AlertPayload): Promise<void> {
    /* Re-checked here and not only on write: a stored row may predate a config
     * change or have been inserted out of band, so the destination is judged
     * again right before the request leaves the process. */
    await assertWebhookAllowed(url);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.notifications.webhookTimeoutMs),
        /* Following a redirect would move the request to a host that was never
         * validated, which is the whole point of the check above. */
        redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
        throw new Error(`Webhook responded ${response.status}; redirects are not followed`);
    }

    if (!response.ok) {
        throw new Error(`Webhook request failed with status ${response.status}`);
    }
}

/* External delivery only. The in-app notification is not sent from here: it is
 * written by markAlertFired() in the same statement that latches the alert, so
 * an alert without a webhook has nothing left to do at this point. */
export async function notifyAlert(alert: Alert, price: number, logger: Logger): Promise<void> {
    if (!alert.webhookUrl) return;

    try {
        await sendWebhook(alert.webhookUrl, buildPayload(alert, price));
        logger.info({ alertId: alert.id, symbol: alert.symbol, price }, 'alert webhook delivered');
    } catch (err) {
        logger.error({ alertId: alert.id, webhookUrl: alert.webhookUrl, err }, 'failed to send webhook notification');
    }
}
