import type { Currency, Language, Theme } from '../types/app';
import {
  THEME_STORAGE_KEY, LANGUAGE_STORAGE_KEY, CURRENCY_STORAGE_KEY, SUPPORTED_CURRENCIES,
} from '../constants';
import { safeGetItem } from './safeStorage';

// Stored UI preferences (theme / language / currency). Reads are tolerant:
// unavailable storage or an unexpected stored value simply means "not set".

export const readStoredTheme = (): Theme | null => {
  const stored = safeGetItem(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' ? stored : null;
};

export const readStoredLanguage = (): Language | null => {
  const stored = safeGetItem(LANGUAGE_STORAGE_KEY);
  return stored === 'ru' || stored === 'en' ? stored : null;
};

export const readStoredCurrency = (): Currency | null => {
  const stored = safeGetItem(CURRENCY_STORAGE_KEY);
  return SUPPORTED_CURRENCIES.includes(stored as Currency) ? (stored as Currency) : null;
};

/** Stored choice, else the browser language ('ru*' -> ru), else English. */
export const detectInitialLanguage = (): Language => {
  const stored = readStoredLanguage();
  if (stored) return stored;
  if (typeof navigator !== 'undefined') {
    const browser = navigator.language?.toLowerCase();
    if (browser?.startsWith('ru')) return 'ru';
  }
  return 'en';
};
