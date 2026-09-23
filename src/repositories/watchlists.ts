import { pool } from '../db/pool.ts';
import type { WatchlistItem } from '../types/alerts.ts';

interface WatchlistRow {
    id: string | number;
    symbol: string;
    owner_id: string | number;
    created_at: Date;
}

function items(row: WatchlistRow): WatchlistItem {
    return {
        id: Number(row.id),
        symbol: row.symbol,
        ownerId: Number(row.owner_id),
        createdAt: row.created_at.toISOString(),    
    }
}
export async function listWatchlist(ownerId: number): Promise<WatchlistItem[]> {
    const { rows } = await pool.query<WatchlistRow>(
        'SELECT id, symbol, owner_id, created_at FROM watchlist WHERE owner_id = $1',
        [ownerId]
    );
    return rows.map(items);
}

export async function addToWatchlist(ownerId: number, symbol: string): Promise<WatchlistItem> {
    const { rows } = await pool.query<WatchlistRow>(
        'INSERT INTO watchlist (symbol, owner_id) VALUES ($1, $2) ON CONFLICT (symbol, owner_id) DO UPDATE SET symbol = EXCLUDED.symbol RETURNING id, symbol, owner_id, created_at',
        [symbol.toUpperCase(), ownerId]
    );
    return items(rows[0]!);
}

export async function removeFromWatchlist(ownerId: number, symbol: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        'DELETE FROM watchlist WHERE owner_id = $1 AND symbol = $2',
        [ownerId, symbol.toUpperCase()]
    );
    return (rowCount ?? 0) > 0;
}