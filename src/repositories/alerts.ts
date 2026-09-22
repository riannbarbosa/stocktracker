import { pool } from '../db/pool.ts';
import type { Alert, NewAlert } from '../types/alerts.ts';

interface AlertRow {
  id: string | number;
  symbol: string;
  direction: string;
  target_price: number;
  webhook_url: string | null;
  email: string | null;
  active: boolean;
  fired_at: Date | null;
  last_price: number | null;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toAlert(row: AlertRow): Alert {
    return {
        id: Number(row.id),
        symbol: row.symbol,
        direction: row.direction === 'below' ? 'below' : 'above',
        targetPrice: Number(row.target_price),
        email: row.email,
        webhookUrl: row.webhook_url,
        active: row.active,
        firedAt: row.fired_at?.toISOString() ?? null,
        lastPrice: row.last_price === null ? null : Number(row.last_price),
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

const COLUMNS = `id, symbol, direction, target_price, webhook_url, email, active,
                 fired_at, last_price, last_checked_at, created_at, updated_at`;

export async function listAlerts(): Promise<Alert[]> {
    const { rows } = await pool.query<AlertRow>(`SELECT ${COLUMNS} FROM alerts ORDER BY created_at DESC`);
    return rows.map(toAlert);
}

export async function findAlert(id: number): Promise<Alert | null> {
  const { rows } = await pool.query<AlertRow>(
    `SELECT ${COLUMNS} FROM alerts WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toAlert(row) : null;
}


export async function createAlert(input: NewAlert): Promise<Alert> {
  const { rows } = await pool.query<AlertRow>(
    `INSERT INTO alerts (symbol, direction, target_price, webhook_url, email)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [
      input.symbol.toUpperCase(),
      input.direction,
      input.targetPrice,
      input.webhookUrl ?? null,
      input.email ?? null,
    ],
  );
  return toAlert(rows[0]!);
}

export async function deleteAlert(id: number): Promise<boolean> {
    const { rowCount } = await pool.query(`DELETE FROM alerts WHERE id = $1`, [id]);
    return ( rowCount ?? 0) > 0;
}

export async function listActiveAlerts(limit: number): Promise<Alert[]> {
  const { rows } = await pool.query<AlertRow>(
    `SELECT ${COLUMNS} FROM alerts
     WHERE active
     ORDER BY last_checked_at ASC NULLS FIRST
     LIMIT $1`,
    [limit],
  );
  return rows.map(toAlert);
}

export async function markAlertFired(id: number, price: number): Promise<void> {
  await pool.query(
    `UPDATE alerts
     SET fired_at = now(), last_price = $2, last_checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, price],
  );
}

export async function markAlertRearmed(id: number, price: number): Promise<void> {
  await pool.query(
    `UPDATE alerts
     SET fired_at = NULL, last_price = $2, last_checked_at = now(), updated_at = now()
     WHERE id = $1`,
    [id, price],
  );
}

export async function touchAlerts(entries: Array<{ id: number; price: number }>): Promise<void> {
  if (entries.length === 0) return;

  await pool.query(
    `UPDATE alerts AS a
     SET last_price = v.price, last_checked_at = now()
     FROM (SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::numeric[]) AS price) AS v
     WHERE a.id = v.id`,
    [entries.map((e) => e.id), entries.map((e) => e.price)],
  );
}