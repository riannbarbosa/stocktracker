import { pool } from '../db/pool.ts';
import type { Notification } from '../types/notifications.ts';

interface NotificationRow {
  id: string | number;
  alert_id: string | number | null;
  symbol: string;
  direction: string;
  target_price: number | string;
  price: number | string;
  read_at: Date | null;
  created_at: Date;
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: Number(row.id),
    alertId: row.alert_id === null ? null : Number(row.alert_id),
    symbol: row.symbol,
    direction: row.direction === 'below' ? 'below' : 'above',
    targetPrice: Number(row.target_price),
    price: Number(row.price),
    readAt: row.read_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const COLUMNS = 'id, alert_id, symbol, direction, target_price, price, read_at, created_at';

/* Rows are written by markAlertFired() in ./alerts.ts; everything here is
 * scoped to one owner, and another owner's id reads as not found. */
export async function listNotifications(
  ownerId: number,
  { unreadOnly = false, limit = 50 }: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const { rows } = await pool.query<NotificationRow>(
    `SELECT ${COLUMNS} FROM notifications
     WHERE owner_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL)
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [ownerId, unreadOnly, limit],
  );
  return rows.map(toNotification);
}

/* COALESCE keeps the first read time: marking an already-read row again is a
 * no-op rather than moving its timestamp. */
export async function markNotificationRead(id: number, ownerId: number): Promise<Notification | null> {
  const { rows } = await pool.query<NotificationRow>(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND owner_id = $2
     RETURNING ${COLUMNS}`,
    [id, ownerId],
  );
  const row = rows[0];
  return row ? toNotification(row) : null;
}

export async function markAllNotificationsRead(ownerId: number): Promise<number> {
  const { rowCount } = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE owner_id = $1 AND read_at IS NULL',
    [ownerId],
  );
  return rowCount ?? 0;
}
