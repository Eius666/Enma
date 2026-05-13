import type { Currency } from '../types';
import type { Locale } from '../i18n';

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  RUB: '₽',
  BYN: 'Br',
  CNY: '¥',
};

/** Return the locale string for Intl formatting. */
function getNumberLocale(language: Locale): string {
  return language === 'ru' ? 'ru-RU' : 'en-US';
}

/**
 * Format a numeric amount as a locale-aware currency string.
 *
 * @example formatCurrency(1234.5, 'RUB', 'ru') // '1 234,50 ₽'
 * @example formatCurrency(1234.5, 'USD', 'en') // '$1,234.50'
 */
export function formatCurrency(
  amount: number,
  currency: Currency | string,
  language: Locale = 'en'
): string {
  return amount.toLocaleString(getNumberLocale(language), {
    style: 'currency',
    currency,
  });
}

/** Return the symbol for a currency code (e.g. 'USD' → '$'). */
export function getCurrencySymbol(currency: Currency | string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

/** Return the ISO 4217 currency code as a string (passthrough helper). */
export function getCurrencyCode(currency: Currency | string): string {
  return currency;
}
