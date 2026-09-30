import type { AlertDirection } from './alerts.ts';

export interface Notification {
  id: number;
  alertId: number | null;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  price: number;
  readAt: string | null;
  createdAt: string;
}
