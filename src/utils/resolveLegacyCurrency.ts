// ── Legacy transaction currency resolver (frontend mirror) ────────────────────
//
// Mirrors api/_lib/finance/resolveLegacyCurrency.js exactly — see that file
// for the full git-history evidence trail behind every boundary here. Do not
// change one without the other; both must use the same historical semantics.
//
// Summary: a transaction missing `currency` is resolved from its real
// historical write-path semantics, never guessed as a blanket RUB default.
//   - source == null, createdAt before 2026-09-18T09:12:56Z (cfb457e, the
//     BASE_CURRENCY: USD → RUB flip) → USD, confidence 'exact'. This covers
//     both the BASE_CURRENCY='USD'+convertToBase() era AND the earlier
//     hardcoded-USD-formatter era before that — both deterministically
//     produced USD-denominated stored amounts.
//   - source == 'telegram-bot' → RUB, confidence 'high' (Telegram never
//     applied conversion math and always displayed a RUB/dynamic symbol
//     matching the user's own currency — never USD-normalized).
//   - anything else unresolvable → UNKNOWN (null), never guessed.

export const WEB_USD_BUG_END = Date.parse('2026-09-18T09:12:56Z'); // cfb457e

export type CurrencyConfidence = 'exact' | 'high' | 'unknown';

export interface ResolvedCurrency {
  currency: string | null;
  confidence: CurrencyConfidence;
  reason: string;
}

interface ResolvableTx {
  currency?: string;
  source?: string;
  createdAt?: { toMillis?: () => number; toDate?: () => Date } | number | null;
  date?: string;
}

function txTimestampMs(tx: Pick<ResolvableTx, 'createdAt' | 'date'>): number | null {
  const c = tx.createdAt;
  if (c && typeof c === 'object') {
    if (typeof c.toMillis === 'function') return c.toMillis();
    if (typeof c.toDate === 'function') return c.toDate().getTime();
  }
  if (typeof c === 'number') return c;
  if (typeof tx.date === 'string') {
    const ms = Date.parse(tx.date);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

export function resolveTransactionCurrency(tx: ResolvableTx): ResolvedCurrency {
  if (tx.currency) {
    return { currency: tx.currency, confidence: 'exact', reason: 'explicit_field' };
  }

  if (tx.source === 'telegram-bot') {
    return { currency: 'RUB', confidence: 'high', reason: 'legacy_telegram_no_conversion_rub_symbol' };
  }

  if (tx.source === 'ai-chat') {
    return { currency: null, confidence: 'unknown', reason: 'unexpected_ai_chat_without_currency' };
  }

  if (!tx.source) {
    const ms = txTimestampMs(tx);
    if (ms === null) {
      return { currency: null, confidence: 'unknown', reason: 'legacy_storage_semantics_unknown_no_timestamp' };
    }
    if (ms < WEB_USD_BUG_END) {
      return { currency: 'USD', confidence: 'exact', reason: 'legacy_web_usd_baseline' };
    }
    return { currency: null, confidence: 'unknown', reason: 'legacy_storage_semantics_unknown_post_fix_gap' };
  }

  return { currency: null, confidence: 'unknown', reason: 'legacy_storage_semantics_unknown_source' };
}
