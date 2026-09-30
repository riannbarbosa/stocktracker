import type { PoolClient } from 'pg';
import { config } from '../config.ts';
import { pool } from '../db/pool.ts';
import { listDigestRecipients, listDigestWatchlist, recordDigestSent } from '../repositories/digest.ts';
import { buildDigestEmail, isDigestDue } from '../services/digest.ts';
import { sendMail, type SendMail } from '../services/mailer.ts';
import { getStockQuotes } from '../services/quotes.ts';
import type { DigestRecipient } from '../types/digest.ts';

interface Logger {
  info: (obj: object, msg?: string) => void;
  debug: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface DigestWorker {
  start: () => void;
  stop: () => Promise<void>;
  runOnce: () => Promise<void>;
}

/* send and now are injectable so the tests need neither SMTP nor a fixed clock. */
export function createDigestWorker(
  logger: Logger,
  { send = sendMail, now = () => new Date() }: { send?: SendMail; now?: () => Date } = {},
): DigestWorker {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<void> | null = null;

  async function sendDigest(recipient: DigestRecipient, at: Date): Promise<void> {
    const watchlist = await listDigestWatchlist(recipient.ownerId);
    /* Not recorded as sent: the summary goes out as soon as there is a ticker. */
    if (watchlist.length === 0) return;

    const { quotes } = await getStockQuotes(watchlist.map((entry) => entry.symbol), { logger });
    const prices = new Map(quotes.map((quote) => [quote.symbol, quote.price]));
    const items = watchlist.map((entry) => ({
      symbol: entry.symbol,
      price: prices.get(entry.symbol) ?? null,
      previousPrice: entry.previousPrice,
    }));

    await send({ to: recipient.email, ...buildDigestEmail(recipient.frequency, items) });

    /* After the send on purpose: if recording fails the user may get the same
     * summary twice, which beats silently skipping one. */
    await recordDigestSent(
      recipient.ownerId,
      items.flatMap((item) => (item.price === null ? [] : [{ symbol: item.symbol, price: item.price }])),
      at,
    );
    logger.info({ ownerId: recipient.ownerId, tickers: items.length }, 'digest sent');
  }

  async function run(): Promise<void> {
    const at = now();
    const due = (await listDigestRecipients()).filter((recipient) =>
      isDigestDue(recipient.frequency, recipient.lastSentAt, at, config.digest),
    );

    for (const recipient of due) {
      /* One user's failure (bad address, quote outage) must not block the rest;
       * nothing was recorded, so the next tick retries them. */
      try {
        await sendDigest(recipient, at);
      } catch (error) {
        logger.error(
          { ownerId: recipient.ownerId, err: error instanceof Error ? error.message : String(error) },
          'digest failed',
        );
      }
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [config.digest.lockKey],
      );
      /* Another replica holds it and is sending; sending here too would
       * deliver every summary twice. */
      if (!rows[0]?.locked) return;

      try {
        await run();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [config.digest.lockKey]);
      }
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'digest cycle failed');
    } finally {
      client?.release();
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        inFlight = tick();
      }, config.digest.checkIntervalMS);
      timer.unref();
      logger.info({ intervalMs: config.digest.checkIntervalMS }, 'digest worker started');
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => {});
      logger.info({}, 'digest worker stopped');
    },

    runOnce: tick,
  };
}
