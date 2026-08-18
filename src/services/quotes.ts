import { fetchStockQuotes } from './brapi.ts';
import type { StockQuote } from '../types/brapi.ts';


export async function getStockQuotes(symbols: string[], { logger }: { logger: any }): Promise<StockQuote[]> {
    return await fetchStockQuotes(symbols);
}