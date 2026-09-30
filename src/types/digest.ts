export type DigestFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

export const DIGEST_FREQUENCIES: DigestFrequency[] = ['off', 'daily', 'weekly', 'monthly'];

export interface DigestSettings {
    frequency: DigestFrequency;
    lastSentAt: string | null;
}

export interface DigestRecipient {
    ownerId: number;
    email: string;
    frequency: Exclude<DigestFrequency, 'off'>;
    lastSentAt: string | null;
}

export interface DigestItem {
    symbol: string;
    price: number | null;
    previousPrice: number | null;
}

