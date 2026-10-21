import { useEffect, useState } from 'react';
import type { Currency, Language, Theme } from '../types/app';
import {
  THEME_STORAGE_KEY, LANGUAGE_STORAGE_KEY, CURRENCY_STORAGE_KEY, BASE_CURRENCY, SUPPORTED_CURRENCIES,
} from '../constants';
import { safeSetItem } from '../lib/safeStorage';
import {
  readStoredTheme, readStoredLanguage, readStoredCurrency, detectInitialLanguage,
} from '../lib/preferences';
import type { TelegramWebApp } from '../telegram';

// Theme / language / currency state with its side effects (body class,
// persistence, Telegram theme and language sync). Moved out of App.tsx; effect
// order and conditions are unchanged. `currency` = the currency NEW operations
// are entered in; budget/analytics are always BASE_CURRENCY (RUB).
export function usePreferences(telegram: TelegramWebApp | null) {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');
  const [hasManualTheme, setHasManualTheme] = useState<boolean>(() => readStoredTheme() !== null);
  const [language, setLanguage] = useState<Language>(() => detectInitialLanguage());
  const [hasManualLanguage, setHasManualLanguage] = useState<boolean>(
    () => readStoredLanguage() !== null
  );
  const [currency, setCurrency] = useState<Currency>(
    () => readStoredCurrency() ?? BASE_CURRENCY
  );

  useEffect(() => {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    if (!hasManualTheme) return;
    safeSetItem(THEME_STORAGE_KEY, theme);
  }, [theme, hasManualTheme]);

  useEffect(() => {
    if (!hasManualLanguage) return;
    safeSetItem(LANGUAGE_STORAGE_KEY, language);
  }, [language, hasManualLanguage]);

  useEffect(() => {
    safeSetItem(CURRENCY_STORAGE_KEY, currency);
  }, [currency]);

  useEffect(() => {
    if (!telegram || hasManualTheme) return;
    const syncTheme = () => {
      const scheme = telegram.colorScheme === 'light' ? 'light' : 'dark';
      setTheme(scheme);
    };
    syncTheme();
    const handleThemeChange = () => syncTheme();
    telegram.onEvent?.('themeChanged', handleThemeChange);
    return () => {
      telegram.offEvent?.('themeChanged', handleThemeChange);
    };
  }, [telegram, hasManualTheme]);

  useEffect(() => {
    if (!telegram || hasManualLanguage) return;
    const tgLanguage = telegram.initDataUnsafe?.user?.language_code?.toLowerCase() ?? '';
    if (tgLanguage.startsWith('ru')) {
      setLanguage('ru');
      return;
    }
    if (tgLanguage) {
      setLanguage('en');
    }
  }, [telegram, hasManualLanguage]);

  useEffect(() => {
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      setCurrency(BASE_CURRENCY);
    }
  }, [currency]);

  const toggleTheme = () => {
    setHasManualTheme(true);
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  const updateLanguage = (next: Language) => {
    setHasManualLanguage(true);
    setLanguage(next);
  };

  return { theme, language, currency, setCurrency, toggleTheme, updateLanguage };
}
