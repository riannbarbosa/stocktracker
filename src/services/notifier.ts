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

interface MailTransport {
     sendMail: (options: { from: string; to: string; subject: string; text: string }) => Promise<unknown>;
}

interface NodemailerModule {
    createTransport: (url: string) => MailTransport;
}

async function sendEmail(to: string, payload: AlertPayload): Promise<void> {
    const smtpUrl = config.notifications.smtpUrl;
    if (!smtpUrl) {
        throw new Error('SMTP URL is not configured');
    }
    const specifier = 'nodemailer';
    const loaded = await import(specifier).catch(() => {
        throw new Error('nodemailer is not installed (yarn add nodemailer)');
    }) as unknown as { default?: NodemailerModule } & Partial<NodemailerModule>;

    const nodemailer = loaded.default ?? (loaded as NodemailerModule);
    const transporter = nodemailer.createTransport(smtpUrl);
    const direction = payload.direction === 'above' ? 'reached or passed' : 'dropped to or below';

    await transporter.sendMail({
        from: config.notifications.emailFrom,
        to,
        subject: `${payload.symbol} ${direction} ${payload.targetPrice}`,
        text: `${payload.symbol} is at ${payload.price} (target ${payload.targetPrice}, ${payload.direction}).`,
    });
}

export async function notifyAlert(alert: Alert, price: number, logger: Logger): Promise<void> {
    const payload = buildPayload(alert, price); 
    const deliveries: Array<Promise<void>> = [];

    if (alert.webhookUrl) {
        deliveries.push(sendWebhook(alert.webhookUrl, payload).catch((err) => {
            logger.error({ alertId: alert.id, webhookUrl: alert.webhookUrl, err }, 'failed to send webhook notification');
        }));
    }

     if (alert.email) {
    deliveries.push(
      sendEmail(alert.email, payload).catch((error: Error) => {
        logger.error({ alertId: alert.id, err: error.message }, 'email delivery failed');
      }),
    );
  }


  if (deliveries.length === 0) {
    logger.warn({ alertId: alert.id }, 'alert has no delivery channel');
    return;
  }

  await Promise.all(deliveries);
  logger.info({ alertId: alert.id, symbol: alert.symbol, price }, 'alert notified');

}
