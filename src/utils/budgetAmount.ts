import type { Transaction } from '../types/app';
import { HOME_BUDGET_CURRENCY } from '../constants';
import { convertCurrency } from './convertCurrency';
import { resolveTransactionCurrency } from './resolveLegacyCurrency';

/**
 * schemaVersion-2 transactions carry a ruble value locked at creation time.
 * Anything without it is a legacy record (resolved + converted at read time).
 */
export function hasLockedRub(tx: Pick<Transaction, 'schemaVersion' | 'rubAmount'>): boolean {
  return tx.schemaVersion === 2 && typeof tx.rubAmount === 'number' && Number.isFinite(tx.rubAmount);
}

/**
 * The transaction's amount in the budget currency (RUB), or null when it
 * cannot be determined (legacy record with unprovable currency).
 * v2 → rubAmount as-is (never re-priced with today's FX).
 */
export function getBudgetAmount(tx: Transaction, rates: Record<string, number>): number | null {
  if (hasLockedRub(tx)) return tx.rubAmount as number;
  const resolved = resolveTransactionCurrency(tx);
  if (resolved.currency === null) return null;
  return convertCurrency(tx.amount, resolved.currency, HOME_BUDGET_CURRENCY, rates);
}

/** The transaction's real (original) currency, or null if unresolvable. */
export function getOriginalCurrency(tx: Transaction): string | null {
  if (hasLockedRub(tx) && tx.currency) return tx.currency;
  return resolveTransactionCurrency(tx).currency;
}

/** Whether the stored FX rate is a bank average or a labelled estimate. */
export function isEstimatedRate(tx: Transaction): boolean {
  return !!tx.fx && tx.fx.source !== 'bank_average';
}
