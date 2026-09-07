import { fetchStockQuotes } from './brapi.ts';
import type { StockQuote } from '../types/brapi.ts';
import { redisClient } from '../redis/redis.ts';
import { config } from '../config.ts';
import { normalizeSymbols } from '../lib/symbols.ts';

export interface QuoteLookup {
  quotes: StockQuote[];
  cacheHits: string[];
  cacheMisses: string[];
}

interface Logger {
  debug: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

const noopLogger: Logger = { debug: () => {}, warn: () => {} };

function cacheKey(symbol: string): string {
  return `${config.quotes.cachePrefix}${symbol}`;
}

const writeCache = async (quotes: StockQuote[], logger: Logger = noopLogger): Promise<void> => {
    if (!redisClient.isReady || quotes.length === 0) return;
    
    try {
        const tx = redisClient.multi();
        for (const quote of quotes) {
            const key = cacheKey(quote.symbol);
            const value = JSON.stringify(quote);
            tx.set(key, value, { EX: config.quotes.cacheTtlSeconds });
        }
        await tx.exec();
        logger.debug({ count: quotes.length }, 'cached stock quotes');
    }catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to write stock quotes to cache');
    }
}


async function readCache(symbols: string[], log: Logger): Promise<Map<string, StockQuote>> {
  const hits = new Map<string, StockQuote>();
  if (!redisClient.isReady || symbols.length === 0) return hits;

  try {
    const values = await redisClient.mGet(symbols.map(cacheKey));

    values.forEach((value, index) => {
      const symbol = symbols[index];
      if (value === null || symbol === undefined) return;
      try {
        hits.set(symbol, JSON.parse(value) as StockQuote);
      } catch {
        /* A poisoned entry (bad JSON, old shape) is treated as a miss and gets
         * overwritten on write-back. */
      }
    });
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'cache read failed, falling through to brapi');
  }

  return hits;
}




export async function getStockQuotes(symbols: string[], { logger = noopLogger }: { logger?: Logger }): Promise<QuoteLookup> {
  const wanted = normalizeSymbols(symbols);
  if (wanted.length === 0) return { quotes: [], cacheHits: [], cacheMisses: [] };
  const cached = await readCache(wanted, logger);
  const misses = wanted.filter((symbol) => !cached.has(symbol));

  logger.debug({ wanted, hits: Array.from(cached.keys()), misses: misses.length }, 'stock quote cache lookup');

  if (misses.length > 0) {
    const fresh = await fetchStockQuotes(misses);
    await writeCache(fresh, logger);
    for (const quote of fresh) cached.set(quote.symbol, quote);
  }

  return {
    quotes: wanted.map((symbol) => cached.get(symbol)).filter((q): q is StockQuote => q !== undefined),
    cacheHits: wanted.filter((symbol) => !misses.includes(symbol)),
    cacheMisses: misses,
  }
}

export async function invalidateQuote(symbol: string): Promise<void> {
  if (!redisClient.isReady) return;
  try { 
    await redisClient.del(cacheKey(symbol));
  } catch {
    /* Best effort — the TTL cleans up anyway. */
  }
}
