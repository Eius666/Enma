'use strict';

// ── Legacy transaction currency resolver ────────────────────────────────────
//
// Resolves the REAL currency a transaction missing `currency` was actually
// stored in, based on PROVEN historical write-path semantics — never guessed.
// Every boundary below is backed by a specific git commit (see the ENMA
// currency-architecture report for the full evidence trail); nothing here is
// inferred from the data itself.
//
// ── Evidence summary ──────────────────────────────────────────────────────
//
// WEB (source == null — Telegram and Web AI chat both always stamp `source`
// and, once they existed, always stamped `currency`; a source-less record can
// only come from the Web UI form, the only path that never has either):
//
//   • acba3c5 (2025-08-21, project inception) → 0a11ceb (2026-01-15T14:36:25Z):
//     the amount formatter hardcoded `currency: 'USD'` — no BASE_CURRENCY, no
//     conversion math existed at all. Whatever number was stored was shown,
//     unconditionally, as USD.
//   • 0a11ceb (2026-01-15T14:36:25Z) → cfb457e (2026-09-18T09:12:56Z):
//     BASE_CURRENCY = 'USD' and `convertToBase(amount) = amount / rates[displayCurrency]`
//     ran on every write. This is a deterministic identity regardless of which
//     display currency was active at entry time:
//       - display = USD  → rates['USD'] is always 1 (self-rate) → amount unchanged,
//         and it was ALREADY being entered/labeled as USD by the UI.
//       - display = anything else → amount / (that currency's rate to USD)
//         IS, by construction, the USD equivalent of what the user typed.
//     Either way the number landed in Firestore is a USD-denominated amount.
//     These two periods are contiguous and produce the same conclusion, so
//     they are treated as a single window ending at cfb457e.
//   • cfb457e (2026-09-18T09:12:56Z) → d59efc3 (2026-09-18T10:23:58Z), ~71 min:
//     BASE_CURRENCY flipped to 'RUB' but `currency` was not yet written on
//     every record. For a RUB-display user (the default, and the norm) this
//     is a no-op → genuinely RUB. For any other display currency active in
//     this narrow window, the same formula now produces an INVERSE
//     corruption (RUB-scale garbage). The two outcomes diverge and neither
//     can be proven from the record alone → UNKNOWN.
//   • d59efc3 (2026-09-18T10:23:58Z) onward: every write includes `currency`
//     explicitly. A record missing it here is anomalous, not legacy.
//
// TELEGRAM (source == 'telegram-bot'): `createTransaction` has never, in any
// historical version (verified back to its first commit, b3e5ba5), applied
// any conversion math — `amount` is always the raw number the LLM extracted,
// and every bot reply has displayed it with a hardcoded ₽ symbol (later a
// dynamic symbol, but only ever populated from the user's OWN currency
// setting — never USD-normalized). This is strong historical/product
// evidence, not a deterministic math proof, so confidence is 'high', not
// 'exact'.
//
// AI-CHAT (source == 'ai-chat'): `tool_createTransaction` (aiTools.js) did
// not exist, in any form, before the currency-architecture work that
// introduced it — every 'ai-chat' record already carries an explicit
// `currency` field by construction. There is no legacy 'ai-chat' population.

const WEB_USD_BUG_END = Date.parse('2026-09-18T09:12:56Z');   // cfb457e — BASE_CURRENCY: USD → RUB
const CURRENCY_FIELD_ADDED_AT = Date.parse('2026-09-18T10:23:58Z'); // d59efc3 — currency written on every record

function txTimestampMs(tx) {
  const c = tx.createdAt;
  if (c && typeof c.toMillis === 'function') return c.toMillis();
  if (c && typeof c.toDate === 'function')   return c.toDate().getTime();
  if (typeof c === 'number')                 return c;
  if (typeof tx.date === 'string') {
    const ms = Date.parse(tx.date);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

// Returns { currency: string|null, confidence: 'exact'|'high'|'unknown', reason: string }
function resolveTransactionCurrency(tx) {
  if (tx.currency) {
    return { currency: tx.currency, confidence: 'exact', reason: 'explicit_field' };
  }

  if (tx.source === 'telegram-bot') {
    return { currency: 'RUB', confidence: 'high', reason: 'legacy_telegram_no_conversion_rub_symbol' };
  }

  if (tx.source === 'ai-chat') {
    // Should be unreachable — every ai-chat record has always carried `currency`.
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

module.exports = {
  resolveTransactionCurrency,
  WEB_USD_BUG_END,
  CURRENCY_FIELD_ADDED_AT,
};
