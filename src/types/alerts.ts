export type AlertDirection = 'above' | 'below';

export interface Alert {
  id: number;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  webhookUrl: string | null;
  active: boolean;
  firedAt: string | null;
  lastPrice: number | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAlert {
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  webhookUrl?: string | null;
}

export interface WatchlistItem {
  id: number;
  symbol: string;
  ownerId: number;
  createdAt: string;
}