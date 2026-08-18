/* Response shapes for the brapi.dev API (https://brapi.dev/docs). */

export interface BrapiQuote {
  symbol: string;
  name?: string;
  shortName?: string;
  longName?: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketVolume?: number;
  regularMarketTime?: string;
  marketCap?: number;
  logourl?: string;
}

export interface BrapiQuoteResponse {
  results?: BrapiQuote[];
  requestedAt?: string;
  took?: string;
}

/* Normalized shape this API serves to clients, derived from BrapiQuote. */
export interface StockQuote {
  symbol: string;
  name: string | null;
  currency: string | null;
  price: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  change: number | null;
  changePercent: number | null;
  time: string | null;
  marketCap: number | null;
  volume: number | null;
  logoUrl: string | null;
  fetchedAt: string;
}
