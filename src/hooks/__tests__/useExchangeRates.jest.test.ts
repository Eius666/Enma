import { renderHook, act, waitFor } from '@testing-library/react';
import { useExchangeRates, pickSupportedRates } from '../useExchangeRates';

const mockCache: { value: unknown; written: unknown[] } = { value: null, written: [] };
const mockFetch = jest.fn();

jest.mock('../../lib/ratesCache', () => ({
  readRatesCache: () => mockCache.value,
  writeRatesCache: (payload: unknown) => { mockCache.written.push(payload); },
}));
jest.mock('../../lib/fetchWithTimeout', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetch(...args) }));

const ok = (rates: Record<string, number>) => ({ ok: true, json: async () => ({ rates }) });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeEach(() => {
  mockCache.value = null;
  mockCache.written = [];
  mockFetch.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test('pickSupportedRates keeps only supported currencies and pins the base to 1', () => {
  expect(pickSupportedRates({ rates: { USD: 0.011, EUR: 0.01, GBP: 0.009, RUB: 5, BYN: 0.035, CNY: 0.08 } }))
    .toEqual({ RUB: 1, USD: 0.011, EUR: 0.01, BYN: 0.035, CNY: 0.08 });
  expect(pickSupportedRates({})).toEqual({ RUB: 1 });
});

test('a fresh cache is used without any network request', async () => {
  mockCache.value = { base: 'RUB', rates: { RUB: 1, USD: 0.5 }, fetchedAt: hoursAgo(0.5) };
  const { result } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(result.current.rates.USD).toBe(0.5));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(result.current.ratesStatus).toBe('idle');
  expect(result.current.ratesUpdatedAt).toBe((mockCache.value as { fetchedAt: string }).fetchedAt);
});

test('no cache: fetches, filters, stores and goes idle', async () => {
  mockFetch.mockResolvedValue(ok({ USD: 0.011, GBP: 0.1 }));
  const { result } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(result.current.ratesStatus).toBe('idle'));
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(String(mockFetch.mock.calls[0][0])).toContain('/latest/RUB');
  expect(mockFetch.mock.calls[0][1]).toEqual({ timeoutMs: 10_000 });
  expect(result.current.rates).toEqual({ RUB: 1, USD: 0.011 });
  expect(mockCache.written).toHaveLength(1);
});

test('a stale cache is shown immediately while fresh rates are requested', async () => {
  mockCache.value = { base: 'RUB', rates: { RUB: 1, USD: 0.4 }, fetchedAt: hoursAgo(3) };
  let resolve!: (v: unknown) => void;
  mockFetch.mockReturnValue(new Promise(r => { resolve = r; }));
  const { result } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(result.current.ratesStatus).toBe('loading'));
  expect(result.current.rates.USD).toBe(0.4);
  await act(async () => { resolve(ok({ USD: 0.6 })); });
  await waitFor(() => expect(result.current.rates.USD).toBe(0.6));
});

test('network failure or a non-OK response ends in "error" and keeps the cached rates', async () => {
  mockCache.value = { base: 'RUB', rates: { RUB: 1, USD: 0.4 }, fetchedAt: hoursAgo(5) };
  mockFetch.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
  const { result: failed } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(failed.current.ratesStatus).toBe('error'));
  expect(failed.current.rates.USD).toBe(0.4);

  mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  const { result: notOk } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(notOk.current.ratesStatus).toBe('error'));
});

test('force reload ignores a fresh cache', async () => {
  mockCache.value = { base: 'RUB', rates: { RUB: 1, USD: 0.5 }, fetchedAt: hoursAgo(0.1) };
  mockFetch.mockResolvedValue(ok({ USD: 0.7 }));
  const { result } = renderHook(() => useExchangeRates());
  await waitFor(() => expect(result.current.rates.USD).toBe(0.5));
  expect(mockFetch).not.toHaveBeenCalled();
  await act(async () => { await result.current.loadExchangeRates(true); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(result.current.rates.USD).toBe(0.7);
});
