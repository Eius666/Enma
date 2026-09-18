import type { Currency } from '../types';

/**
 * Pure currency conversion.
 * `rates` must be keyed by currency code with values expressed as
 * "units of that currency per 1 RUB" (i.e. the output of
 * exchangerate-api.com/v4/latest/RUB).
 *
 * If from === to, returns amount unchanged — no FX involved.
 */
export function convertCurrency(
  amount: number,
  from: Currency | string,
  to: Currency | string,
  rates: Record<string, number>,
): number {
  if (from === to) return amount;
  const fromRate = rates[from] ?? 1; // from → RUB: divide
  const toRate   = rates[to]   ?? 1; // RUB → to:   multiply
  return (amount / fromRate) * toRate;
}
