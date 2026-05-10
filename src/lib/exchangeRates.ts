import type { Currency } from '../types';

export const RATES_STORAGE_KEY = 'enma.exchangeRates';
export const RATES_TTL_MS = 60 * 60 * 1000;

type RatesCache = {
  base: Currency;
  rates: Record<string, number>;
  fetchedAt: string;
};

export const readRatesCache = (): RatesCache | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RATES_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RatesCache;
  } catch {
    return null;
  }
};

export const writeRatesCache = (payload: RatesCache) => {
  try {
    localStorage.setItem(RATES_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Failed to persist exchange rates', error);
  }
};
