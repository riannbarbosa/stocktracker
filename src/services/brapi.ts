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

  
async function requestStockQuote(symbol: string): Promise<BrapiQuote> {
  const url = `${config.brapi.baseUrl}/quote/${symbol}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if(config.brapi.token) {
    headers['Authorization'] = `Bearer ${config.brapi.token}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(config.brapi.timeoutMs) });
  if (!response.ok) {
    throw new BrapiError(`Failed to fetch stock quote for ${symbol}`, { status: response.status });
  }

  const body = (await response.json()) as BrapiQuoteResponse;
  const result = body?.results?.[0];
  if (!result) {
    throw new BrapiError(`No stock quote found for ${symbol}`, { status: 404 });
  }
  return result;
}

export async function fetchStockQuotes(symbols: string[]): Promise<StockQuote[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.brapi.retryCount; attempt++) {
    try {
      const quotes = await Promise.all(symbols.map(requestStockQuote));
      return quotes.map(normalizeSymbol);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError;
}
