import { config } from '../config.ts';
import { pool } from '../db/pool.ts';
import type { PoolClient } from 'pg';
import { getStockQuotes } from '../services/quotes.ts';
import { evaluateAlert } from '../services/alerts.ts';
import { notifyAlert } from '../services/notifier.ts';
import {
    listActiveAlerts,
    markAlertFired,
    markAlertRearmed,
    touchAlerts
} from '../repositories/alerts.ts';

interface Logger {
    info: (obj: object, msg?: string) => void;
    debug: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
}

export interface AlertPoller {
    start: () => void;
    stop: () => void;
    runOnce: () => Promise<void>;
}


export function createAlertPoller(logger: Logger): AlertPoller {
    let timer: NodeJS.Timeout | null = null;
    let running = false;
    let inFlight: Promise<void> | null = null;

    async function poll(): Promise<void> {
        const alerts = await listActiveAlerts(config.alerts.batchSize);
        if(alerts.length === 0) return;

        const symbols = [...new Set(alerts.map(alert => alert.symbol))];

        const { quotes } = await getStockQuotes(symbols, { logger: logger });
        const prices = new Map(quotes.map((quote) => [quote.symbol, quote.price]));  
        
        const unchanged: Array<{ id: number; price: number }> = [];

        for (const alert of alerts) {
            const price = prices.get(alert.symbol); 
            if (price == null) {
                logger.warn({
                    alertId: alert.id,
                    symbol: alert.symbol,
                }, `No price available for alert symbol`);
                continue;
            }

            const outcome = evaluateAlert(alert, price);
            if (outcome === 'trigger') {
                await markAlertFired(alert.id, price);
                await notifyAlert(alert, price, logger);
            } else if (outcome === 'rearm') {
                await markAlertRearmed(alert.id, price);
                logger.debug({ alertId: alert.id, price }, 'alert re-armed');
            } else {
                unchanged.push({ id: alert.id, price });
            }
        }

        await touchAlerts(unchanged);
        logger.debug({ processed: alerts.length, symbols: symbols.length }, 'alert poller cycle complete'); 
    }

    async function tick(): Promise<void> {
        if (running){
            logger.warn({}, 'previous alert poll still running, skipping tick');
            return;
        }

        running = true;

        let client: PoolClient | undefined;
        try {
            client = await pool.connect();
            const { rows } = await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1) AS locked',
                [config.alerts.lockKey],
            );

            if(!rows[0]?.locked) {
                logger.debug({}, 'another instance of the alert poller is already running, skipping tick');
                return;
            }

           try {
        await poll();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [config.alerts.lockKey]);
      }
        }
        catch (error) {
      /* A failed tick must never kill the interval — the next one retries. */
      logger.error({ err: error instanceof Error ? error.message : String(error) }, 'alert poll failed');
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
      }, config.alerts.pollIntervalMs);
      /* unref: a pending interval shouldn't hold the event loop open during
       * shutdown. */
      timer.unref();
      logger.info({ intervalMs: config.alerts.pollIntervalMs }, 'alert poller started');
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => {});
      logger.info({}, 'alert poller stopped');
    },

    runOnce: tick,
  };
}