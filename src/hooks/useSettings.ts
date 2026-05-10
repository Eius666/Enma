import { useEffect, useState } from 'react';
import type { TelegramWebApp } from '../telegram';
import type { Currency, Language, Theme } from '../types';
import {
  BASE_CURRENCY,
  CURRENCY_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_CURRENCIES,
  THEME_STORAGE_KEY
} from '../lib/utils';

const readStoredTheme = (): Theme | null => {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' ? stored : null;
};

const readStoredLanguage = (): Language | null => {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === 'ru' || stored === 'en' ? stored : null;
};

const readStoredCurrency = (): Currency | null => {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(CURRENCY_STORAGE_KEY);
  return SUPPORTED_CURRENCIES.includes(stored as Currency) ? (stored as Currency) : null;
};

const detectInitialLanguage = (): Language => {
  const stored = readStoredLanguage();
  if (stored) return stored;
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru')) {
    return 'ru';
  }
  return 'en';
};

export const useSettings = (telegram: TelegramWebApp | null) => {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');
  const [hasManualTheme, setHasManualTheme] = useState<boolean>(() => readStoredTheme() !== null);
  const [language, setLanguage] = useState<Language>(() => detectInitialLanguage());
  const [hasManualLanguage, setHasManualLanguage] = useState<boolean>(
    () => readStoredLanguage() !== null
  );
  const [currency, setCurrency] = useState<Currency>(() => readStoredCurrency() ?? BASE_CURRENCY);

  useEffect(() => {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    if (!hasManualTheme) return;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (e) { console.warn(e); }
  }, [theme, hasManualTheme]);

  useEffect(() => {
    if (!telegram || hasManualTheme) return;
    const syncTheme = () => setTheme(telegram.colorScheme === 'light' ? 'light' : 'dark');
    syncTheme();
    telegram.onEvent?.('themeChanged', syncTheme);
    return () => telegram.offEvent?.('themeChanged', syncTheme);
  }, [telegram, hasManualTheme]);

  useEffect(() => {
    if (!hasManualLanguage) return;
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch (e) { console.warn(e); }
  }, [language, hasManualLanguage]);

  useEffect(() => {
    if (!telegram || hasManualLanguage) return;
    const tgLang = telegram.initDataUnsafe?.user?.language_code?.toLowerCase() ?? '';
    if (tgLang.startsWith('ru')) setLanguage('ru');
    else if (tgLang) setLanguage('en');
  }, [telegram, hasManualLanguage]);

  useEffect(() => {
    try { localStorage.setItem(CURRENCY_STORAGE_KEY, currency); } catch (e) { console.warn(e); }
  }, [currency]);

  useEffect(() => {
    if (!SUPPORTED_CURRENCIES.includes(currency)) setCurrency(BASE_CURRENCY);
  }, [currency]);

  const toggleTheme = () => {
    setHasManualTheme(true);
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  const updateLanguage = (next: Language) => {
    setHasManualLanguage(true);
    setLanguage(next);
  };

  const updateCurrency = (next: Currency) => {
    if (next !== currency) setCurrency(next);
  };

  return { theme, language, currency, toggleTheme, updateLanguage, updateCurrency };
};
