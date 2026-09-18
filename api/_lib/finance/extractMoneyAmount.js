'use strict';

// ── Explicit monetary amount + currency parser ────────────────────────────────
//
// Distinguishes "5000 USD" from "5000 ₽" from a bare "5000" in free-text user
// messages. Without this, "Могу купить ноутбук за 5000 USD?" for a
// RUB-baseCurrency user would silently treat 5000 as RUB — a correctness bug
// distinct from (and upstream of) transaction-currency normalization.
//
// Returns { amount, currency, explicitCurrency } or null if no amount found.
//   explicitCurrency: true  → currency was named in the text (symbol or word)
//   explicitCurrency: false → no currency named; `currency` is the caller's
//                             defaultCurrency (per spec: explicit → user's
//                             calculation currency → RUB)

// All non-capturing (?:...) — tokenSrc gets embedded inside two other
// capturing groups (the digits) below, and a capturing group here would
// shift those groups' indices and silently break mBefore[1]/mAfter[1].
const CURRENCY_PATTERNS = [
  // RUB: ₽, руб/рублей/рубля/рубль, RUB
  { currency: 'RUB', re: /(?:руб(?:лей|ля|ь)?\.?|₽|\bRUB\b)/i },
  // USD: $, доллар(ов), USD — $ as a character class so .source round-trips
  // safely when interpolated into another RegExp (a bare \$ loses its escape
  // through .source and becomes an end-of-string anchor instead of a literal $).
  { currency: 'USD', re: /(?:долларов|доллара|доллар|[$]|\bUSD\b)/i },
  // EUR: €, евро, EUR
  { currency: 'EUR', re: /(?:евро|€|\bEUR\b)/i },
];

// Matches "<number><optional space><currency token>" OR "<currency symbol><number>"
// in either order, since both "5000$" / "$5000" / "5000 USD" / "USD 5000" occur.
function findExplicitAmount(text) {
  for (const { currency, re } of CURRENCY_PATTERNS) {
    const tokenSrc = re.source;
    // number BEFORE the currency token: "5000 USD", "5000$", "150 000 ₽"
    const before = new RegExp(`(\\d[\\d\\s ]*(?:[,.]\\d+)?)\\s*(?:${tokenSrc})`, 'i');
    const mBefore = text.match(before);
    if (mBefore) {
      const n = parseFloat(mBefore[1].replace(/[\s ]/g, '').replace(',', '.'));
      if (!isNaN(n) && n > 0) return { amount: n, currency, explicitCurrency: true };
    }
    // currency token BEFORE the number: "$5000", "USD 5000"
    const after = new RegExp(`(?:${tokenSrc})\\s*(\\d[\\d\\s ]*(?:[,.]\\d+)?)`, 'i');
    const mAfter = text.match(after);
    if (mAfter) {
      const n = parseFloat(mAfter[1].replace(/[\s ]/g, '').replace(',', '.'));
      if (!isNaN(n) && n > 0) return { amount: n, currency, explicitCurrency: true };
    }
  }
  return null;
}

// "150к" / "150 тысяч" / "150k" — no currency symbol, just magnitude shorthand
function findShorthandAmount(text) {
  const m = text.match(/(\d+(?:[,.]\d+)?)\s*(?:тысяч(?:и)?|тыс\.?|к(?![а-яёА-ЯЁ])|[kK]\b)/i);
  if (m) {
    const n = parseFloat(m[1].replace(',', '.')) * 1000;
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

// Bare number preceded by a trigger word, no currency named at all.
// "на" covers delta phrasing ("на 500 больше", "увеличится на 1000") — very
// common for what-if scenario modifications, not just purchases.
function findImplicitAmount(text) {
  const m = text.match(/(?:за|купить|куплю|стоит|стоимость|стоимостью|потрат|накопить|накоплю|на)\s+\$?€?([\d][\d\s]{2,})/i);
  if (m) {
    const n = parseFloat(m[1].replace(/[\s ]/g, ''));
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

function extractMoneyAmount(text, defaultCurrency) {
  if (!text || typeof text !== 'string') return null;
  const base = defaultCurrency || 'RUB';

  const explicit = findExplicitAmount(text);
  if (explicit) return explicit;

  const shorthand = findShorthandAmount(text);
  if (shorthand !== null) return { amount: shorthand, currency: base, explicitCurrency: false };

  const implicit = findImplicitAmount(text);
  if (implicit !== null) return { amount: implicit, currency: base, explicitCurrency: false };

  return null;
}

module.exports = { extractMoneyAmount };
