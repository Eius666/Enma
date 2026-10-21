import { useCallback, useEffect, useState } from 'react';
import { BASE_CURRENCY, RATES_TTL_MS, SUPPORTED_CURRENCIES } from '../constants';
import { fetchWithTimeout } from '../lib/fetchWithTimeout';
import { readRatesCache, writeRatesCache } from '../lib/ratesCache';

// Keeps only the supported currencies from the provider's response (BASE = 1).
export const pickSupportedRates = (data: { rates?: Record<string, number> }): Record<string, number> =>
  SUPPORTED_CURRENCIES.reduce<Record<string, number>>((acc, code) => {
    const rate = code === BASE_CURRENCY ? 1 : data.rates?.[code];
    if (rate) acc[code] = rate;
    return acc;
  }, { [BASE_CURRENCY]: 1 });

// Exchange-rate state: serves a fresh cache (< RATES_TTL_MS) without a request,
// otherwise shows the stale cache while fetching. Moved out of App.tsx; logic
// unchanged (the request now has a timeout so 'loading' cannot hang forever).
export function useExchangeRates() {
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
      const response = await fetchWithTimeout(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`, { timeoutMs: 10_000 });
      if (!response.ok) throw new Error('Failed to load exchange rates');
      const data = (await response.json()) as { rates: Record<string, number> };
      const filteredRates = pickSupportedRates(data);
      const fetchedAt = new Date().toISOString();
      setRates(filteredRates);
      setRatesUpdatedAt(fetchedAt);
      writeRatesCache({ base: BASE_CURRENCY, rates: filteredRates, fetchedAt });
      setRatesStatus('idle');
    } catch (error) {
      console.warn('Failed to fetch exchange rates', error);
      setRatesStatus('error');
    }
  }, []);

  useEffect(() => {
    loadExchangeRates();
  }, [loadExchangeRates]);

  return { rates, ratesUpdatedAt, ratesStatus, loadExchangeRates };
}
