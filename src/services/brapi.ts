import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.ts';
import type { BrapiQuote, BrapiQuoteResponse, StockQuote } from '../types/brapi.ts';

export class BrapiError extends Error {
  status: number;

  constructor(message: string, { status }: { status: number }) {
    super(message);
    this.name = "BrapiError";
    this.status = status;
  }
}



function normalizeSymbol(raw: BrapiQuote): StockQuote {
  return {
    symbol: raw.symbol.toUpperCase(),
    name: raw.shortName ?? raw.longName ?? null,
    currency: raw.currency ?? null,
    price: raw.regularMarketPrice ?? null,
    dayHigh: raw.regularMarketDayHigh ?? null,
    dayLow: raw.regularMarketDayLow ?? null,
    change: raw.regularMarketChange ?? null,
    changePercent: raw.regularMarketChangePercent ?? null,
    time: raw.regularMarketTime ?? null,
    marketCap: raw.marketCap ?? null,   
    volume: raw.regularMarketVolume ?? null,
    logoUrl: raw.logourl ?? null,
    fetchedAt: new Date().toISOString()
  }
}

function isRetryable(error: unknown): boolean { 
  if (error instanceof BrapiError) {
    return error.status >= 500 || error.status === 429;
  }
  return false;
}
  
async function requestStockQuote(symbol: string): Promise<BrapiQuote> {
  const url = `${config.brapi.baseUrl}/quote/${encodeURIComponent(symbol)}`;
  const headers: Record<string, string> = { accept: 'application/json' };

  if (config.brapi.token) {
    headers['Authorization'] = `Bearer ${config.brapi.token}`;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(config.brapi.timeoutMs),
  });

  if (!response.ok) {
    const message = response.status === 404
      ? `Unknown symbol: ${symbol}`
      : `brapi responded ${response.status} for ${symbol}`;
    throw new BrapiError(message, { status: response.status });
  }

  const body = (await response.json()) as BrapiQuoteResponse;
  const result = body?.results?.[0];

  if (!result) {
    throw new BrapiError(`Unknown symbol: ${symbol}`, { status: 404 });
  }

  return result;
}

async function fetchOne(symbol: string): Promise<StockQuote> {
  let lastError: unknown;

  for (let attempt = 0; attempt < config.brapi.retryCount; attempt++) {
    try {
      return normalizeSymbol(await requestStockQuote(symbol));
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.brapi.retryCount - 1) break;
      const delay = config.brapi.retryBaseDelayMs * 2 ** attempt;
      await sleep(delay + Math.floor(Math.random() * 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}


export async function fetchStockQuotes(symbols: string[]): Promise<StockQuote[]> {
  return Promise.all(symbols.map(fetchOne));
}