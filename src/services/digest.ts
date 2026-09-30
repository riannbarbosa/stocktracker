import type { DigestFrequency, DigestItem, DigestRecipient } from '../types/digest.ts';

const DAY_MS = 86_400_000;


export function localClock(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function isDigestDue(
    frequency: DigestFrequency,
    lastSentAt: string | null,
    now: Date,
    {sendHour, timeZone}: {sendHour: number; timeZone: string},
): boolean {
    if (frequency === 'off') return false;
    
    const today = localClock(now, timeZone);
    if (today.hour < sendHour) return false;
    
    if (lastSentAt === null) return true;
    const last = localClock(new Date(lastSentAt), timeZone);
    switch (frequency) {
        case 'daily':
            return today.date > last.date;
        case 'weekly':
            return (Date.parse(today.date) - Date.parse(last.date)) / DAY_MS >= 7;
        case 'monthly':
            return today.date.slice(0, 7) > last.date.slice(0, 7);
  }
}

const LABEL: Record<DigestRecipient['frequency'], string> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

function change(item: DigestItem): string {
  if (item.price === null) return 'price unavailable';
  if (item.previousPrice === null || item.previousPrice === 0) return 'new';
  const percent = ((item.price - item.previousPrice) / item.previousPrice) * 100;
  return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

export function buildDigestEmail(
  frequency: DigestRecipient['frequency'],
  items: DigestItem[],
): { subject: string; text: string } {
  const lines = items.map((item) =>
    [item.symbol.padEnd(8), (item.price === null ? '-' : item.price.toFixed(2)).padStart(10), `  ${change(item)}`].join(''),
  );
  const count = `${items.length} ticker${items.length === 1 ? '' : 's'}`;

  return {
    subject: `Your ${LABEL[frequency]} watchlist summary (${count})`,
    text: [
      `Your ${LABEL[frequency]} watchlist summary`,
      '',
      ...lines,
      '',
      'Change is measured against the price in your previous summary.',
    ].join('\n'),
  };
}