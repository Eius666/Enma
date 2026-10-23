import type { Currency } from '../types';

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

// Budget / analytics currency is FIXED. `user.currency` (the selector in
// Settings) is only the currency NEW operations are entered in.
export const HOME_BUDGET_CURRENCY: Currency = 'RUB';
export const BASE_CURRENCY: Currency = 'RUB';
export const SUPPORTED_CURRENCIES: Currency[] = ['RUB', 'USD', 'EUR', 'BYN', 'CNY'];

// ---------------------------------------------------------------------------
// Exchange rates cache
// ---------------------------------------------------------------------------

export const RATES_STORAGE_KEY = 'enma.exchangeRates';
export const RATES_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Preferences storage keys
// ---------------------------------------------------------------------------

export const THEME_STORAGE_KEY = 'enma.theme';
export const LANGUAGE_STORAGE_KEY = 'enma.language';
export const CURRENCY_STORAGE_KEY = 'enma.currency';

// ---------------------------------------------------------------------------
// Per-user data storage keys (used as `enma.{uid}.{key}`)
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = {
  tasks: 'tasks',
  notes: 'notes',
  noteProjects: 'notes.projects',
  categories: 'finance.categories',
  transactions: 'finance.transactions',
  habits: 'habits',
  reminders: 'reminders',
} as const;

export const PROFILE_STORAGE_PREFIX = 'profile';
