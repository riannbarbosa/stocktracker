import { config } from '../config.ts';

/* B3 tickers are 4 letters + 1-2 digits (PETR4, BOVA11), optionally with an F
 * suffix for the fractional market. Kept permissive enough for brapi's other
 * assets (indexes, BDRs) without letting arbitrary path segments through. */
export const SYMBOL_PATTERN = '^[A-Za-z]{2,6}[0-9]{0,2}[Ff]?$';

const SYMBOL_REGEX = new RegExp(SYMBOL_PATTERN);

export function symbolListPattern(max = config.quotes.maxSymbolsPerRequest): string {
  const one = SYMBOL_PATTERN.slice(1, -1);
  return `^${one}(,${one}){0,${max - 1}}$`;
}

export function isValidSymbol(raw: string): boolean {
  return SYMBOL_REGEX.test(raw);
}
export function normalizeSymbols(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of raw) {
    const symbol = entry.trim().toUpperCase();
    if (symbol === '' || seen.has(symbol)) continue;
    seen.add(symbol);
    result.push(symbol);
  }

  return result;
}