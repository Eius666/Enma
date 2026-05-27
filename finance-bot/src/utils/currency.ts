export type Currency = 'RUB' | 'USD' | 'EUR';

export function detectCurrency(text: string): Currency {
  const lower = text.toLowerCase();
  if (lower.includes('$') || /\b(usd)\b/.test(lower)) {
    return 'USD';
  }
  if (lower.includes('€') || /\b(eur)\b/.test(lower)) {
    return 'EUR';
  }
  if (lower.includes('₽') || /\b(rub)\b/.test(lower)) {
    return 'RUB';
  }
  return 'RUB';
}

export function stripCurrencyTokens(text: string): string {
  return text
    .replace(/\b(usd|eur|rub)\b/gi, ' ')
    .replace(/[€$₽]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₽';
  const formatted = Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
  return `${formatted} ${symbol}`;
}
