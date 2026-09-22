import { pool } from '../db/pool.ts';
import type { WatchlistItem } from '../types/alerts.ts';

interface WatchlistRow {
    id: string | number;
    symbol: string;
    owner: string;
    created_at: Date;
}

function items(row: WatchlistRow): WatchlistItem {
    return {
        id: Number(row.id),
        symbol: row.symbol,
        owner: row.owner,
        createdAt: row.created_at.toISOString(),    
    }
}
export async function listWatchlist(owner: string): Promise<WatchlistItem[]> {
    const { rows } = await pool.query<WatchlistRow>(
        'SELECT id, symbol, owner, created_at FROM watchlist WHERE owner = $1',
        [owner]
    );
    return rows.map(items);
}

export async function addToWatchlist(owner: string, symbol: string): Promise<WatchlistItem> {
    const { rows } = await pool.query<WatchlistRow>(
        'INSERT INTO watchlist (symbol, owner) VALUES ($1, $2) ON CONFLICT (symbol, owner) DO UPDATE SET symbol = EXCLUDED.symbol RETURNING id, symbol, owner, created_at',
        [symbol.toUpperCase(), owner]
    );
    return items(rows[0]!);
}

export async function removeFromWatchlist(owner: string, symbol: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        'DELETE FROM watchlist WHERE owner = $1 AND symbol = $2',
        [owner, symbol.toUpperCase()]
    );
    return (rowCount ?? 0) > 0;
}