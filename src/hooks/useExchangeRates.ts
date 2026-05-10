import { useCallback, useState } from 'react';
import { readRatesCache, RATES_TTL_MS, writeRatesCache } from '../lib/exchangeRates';
import { BASE_CURRENCY, SUPPORTED_CURRENCIES } from '../lib/utils';
import type { Currency } from '../types';

export const useExchangeRates = () => {
  const [rates, setRates] = useState<Record<string, number>>({ [BASE_CURRENCY]: 1 });
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState<string | null>(null);
  const [ratesStatus, setRatesStatus] = useState<'idle' | 'loading' | 'error'>('idle');

  const loadExchangeRates = useCallback(async (force = false) => {
    const cached = readRatesCache();
    if (cached) {
      const isFresh =
        cached.base === BASE_CURRENCY &&
        Date.now() - new Date(cached.fetchedAt).getTime() < RATES_TTL_MS;
      if (!force && isFresh) {
        setRates(cached.rates);
        setRatesUpdatedAt(cached.fetchedAt);
        setRatesStatus('idle');
        return;
      }
      setRates(cached.rates);
      setRatesUpdatedAt(cached.fetchedAt);
    }

    setRatesStatus('loading');
    try {
      const response = await fetch(
        `https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`
      );
      if (!response.ok) throw new Error('Failed to load exchange rates');
      const data = (await response.json()) as { rates: Record<string, number> };
      const filteredRates = SUPPORTED_CURRENCIES.reduce<Record<string, number>>(
        (acc, code) => {
          const rate = code === BASE_CURRENCY ? 1 : data.rates?.[code];
          if (rate) acc[code] = rate;
          return acc;
        },
        { [BASE_CURRENCY]: 1 }
      );
      const fetchedAt = new Date().toISOString();
      setRates(filteredRates);
      setRatesUpdatedAt(fetchedAt);
      writeRatesCache({ base: BASE_CURRENCY as Currency, rates: filteredRates, fetchedAt });
      setRatesStatus('idle');
    } catch (error) {
      console.warn('Failed to fetch exchange rates', error);
      setRatesStatus('error');
    }
  }, []);

  return { rates, ratesUpdatedAt, ratesStatus, loadExchangeRates };
};
