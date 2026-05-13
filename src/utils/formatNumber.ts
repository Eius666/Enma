import type { Locale } from '../i18n';

/**
 * Format a number with locale-aware thousands separators.
 *
 * @example formatNumber(1234567, 'ru') // '1 234 567'
 * @example formatNumber(1234567, 'en') // '1,234,567'
 */
export function formatNumber(num: number, language: Locale = 'en'): string {
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  return num.toLocaleString(locale);
}

/**
 * Format a value (0–100) as a percentage string.
 *
 * @example formatPercentage(42.5)    // '42.5%'
 * @example formatPercentage(42.5, 0) // '43%'
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Compact-format a large number (e.g. 1_500_000 → '1.5M').
 * Falls back to full formatting for numbers under 1000.
 */
export function formatCompact(num: number, language: Locale = 'en'): string {
  const locale = language === 'ru' ? 'ru-RU' : 'en-US';
  if (Math.abs(num) >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(num) >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toLocaleString(locale);
}
