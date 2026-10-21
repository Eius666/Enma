import type { Currency } from '../types/app';
import { RATES_STORAGE_KEY } from '../constants';
import { safeReadJson, safeWriteJson } from './safeStorage';

// Cached exchange rates (localStorage is only a cache; rates are refetched when stale).
export type RatesCache = {
  base: Currency;
  rates: Record<string, number>;
  fetchedAt: string;
};

export const readRatesCache = (): RatesCache | null => safeReadJson<RatesCache | null>(RATES_STORAGE_KEY, null);

export const writeRatesCache = (payload: RatesCache): void => {
  safeWriteJson(RATES_STORAGE_KEY, payload);
};
