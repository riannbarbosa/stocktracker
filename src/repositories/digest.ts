import { pool } from '../db/pool.ts';
import type { DigestFrequency, DigestRecipient, DigestSettings } from '../types/digest.ts';

interface SettingsRow {
    digest_frequency: DigestFrequency;
    digest_last_sent_at: Date | null;
}

function toSettings(row: SettingsRow): DigestSettings {
  return {
    frequency: row.digest_frequency,
    lastSentAt: row.digest_last_sent_at?.toISOString() ?? null,
  };
}

export async function getDigestSettings(ownerId: number): Promise<DigestSettings | null> {
      const { rows } = await pool.query<SettingsRow>(
    'SELECT digest_frequency, digest_last_sent_at FROM users WHERE id = $1',
    [ownerId],
  );
  const row = rows[0];
  return row ? toSettings(row) : null;
}

export async function setDigestFrequency(ownerId: number, frequency: DigestFrequency): Promise<DigestSettings | null> {
  const { rows } = await pool.query<SettingsRow>(
    'UPDATE users SET digest_frequency = $2 WHERE id = $1 RETURNING digest_frequency, digest_last_sent_at',
    [ownerId, frequency],
  );
  const row = rows[0];
  return row ? toSettings(row) : null;
}

/* Worker path from here down: not scoped to a request's owner. */

interface RecipientRow {
  id: string | number;
  email: string;
  digest_frequency: DigestRecipient['frequency'];
  digest_last_sent_at: Date | null;
}

/* Every user with the digest on. Whether each one is due is decided in
 * isDigestDue(), which needs the local calendar that SQL would not share. */
export async function listDigestRecipients(): Promise<DigestRecipient[]> {
  const { rows } = await pool.query<RecipientRow>(
    `SELECT id, email, digest_frequency, digest_last_sent_at FROM users
     WHERE digest_frequency <> 'off'
     ORDER BY digest_last_sent_at ASC NULLS FIRST`,
  );
  return rows.map((row) => ({
    ownerId: Number(row.id),
    email: row.email,
    frequency: row.digest_frequency,
    lastSentAt: row.digest_last_sent_at?.toISOString() ?? null,
  }));
}

interface WatchlistPriceRow {
  symbol: string;
  previous_price: number | string | null;
}

export async function listDigestWatchlist(ownerId: number): Promise<Array<{ symbol: string; previousPrice: number | null }>> {
  const { rows } = await pool.query<WatchlistPriceRow>(
    `SELECT w.symbol, p.price AS previous_price
     FROM watchlist w
     LEFT JOIN digest_prices p ON p.owner_id = w.owner_id AND p.symbol = w.symbol
     WHERE w.owner_id = $1
     ORDER BY w.symbol`,
    [ownerId],
  );
  return rows.map((row) => ({
    symbol: row.symbol,
    previousPrice: row.previous_price === null ? null : Number(row.previous_price),
  }));
}

/* One statement: the send is recorded and the prices the next summary compares
 * against are saved together. A data-modifying CTE always runs, so the UPDATE
 * happens even when there are no prices to store. sentAt comes from the worker
 * rather than now(), so the next isDigestDue() reads the same clock it wrote. */
export async function recordDigestSent(
  ownerId: number,
  prices: Array<{ symbol: string; price: number }>,
  sentAt: Date,
): Promise<void> {
  await pool.query(
    `WITH sent AS (
       UPDATE users SET digest_last_sent_at = $4 WHERE id = $1
     )
     INSERT INTO digest_prices (owner_id, symbol, price, recorded_at)
     SELECT $1, v.symbol, v.price, $4
     FROM UNNEST($2::text[], $3::numeric[]) AS v(symbol, price)
     ON CONFLICT (owner_id, symbol)
     DO UPDATE SET price = EXCLUDED.price, recorded_at = EXCLUDED.recorded_at`,
    [ownerId, prices.map((p) => p.symbol), prices.map((p) => p.price), sentAt],
  );
}
