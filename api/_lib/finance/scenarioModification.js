'use strict';

const { extractMoneyAmount } = require('./extractMoneyAmount');

// ── What-if scenario modification parser ──────────────────────────────────────
//
// Parses free-text like "буду тратить на $500 больше" into a structured,
// currency-aware modification. Reuses extractMoneyAmount for the amount +
// currency detection — this is NOT a second currency parser, just the
// direction/type keywords layered on top.
//
// Returns { type, delta, currency } or null when no modification is detectable.
//   type: 'income_change' | 'expense_change' | 'savings_change'
//   delta: signed number, already in `currency` (NOT yet converted to the
//          calculation currency — that happens at apply-time, once, where
//          FX availability can be checked and failures surfaced honestly).
//   currency: the currency the amount was actually stated in, or `null` when
//          no currency was named at all AND there is no previous turn to
//          inherit one from — callers should treat null as "resolve against
//          the calculation currency at apply-time," never guess earlier.
//
// Follow-up (spec): "А если буду тратить на $500 больше?" → "А если на $300?"
// — the second turn names only an amount, no type/direction/currency of its
// own. `previous` (the prior turn's parsed modification, from conversation
// state) supplies type, direction (sign) and currency when the current
// message doesn't restate them; only `delta`'s magnitude is replaced.

const TYPE_PATTERNS = [
  { type: 'expense_change', re: /трат|расход/i },
  { type: 'savings_change', re: /отклад|сберега|сбережени|накопл|копить/i },
  { type: 'income_change',  re: /доход|зарплат|заработ/i },
];

// Stems, not full conjugations — "увеличится"/"увеличатся"/"увеличу" etc.
// all share "увелич"; matching the stem avoids an unbounded verb-form list.
const MORE_RE = /больше|вырост|выраст|увелич|прибав/i;
const LESS_RE = /меньше|сниз|уменьш|сократ|упад/i;

function parseScenarioModification(message, previous = null) {
  const text = String(message || '');

  // The defaultCurrency argument only matters for the *implicit* case, which
  // we discard below in favor of `null` (deferred resolution) — its value
  // here is never surfaced to the caller.
  const parsedAmount = extractMoneyAmount(text, 'RUB');
  if (!parsedAmount) return null;

  let type = null;
  for (const { type: t, re } of TYPE_PATTERNS) {
    if (re.test(text)) { type = t; break; }
  }

  let sign = null;
  if (MORE_RE.test(text)) sign = 1;
  else if (LESS_RE.test(text)) sign = -1;

  if (type === null && previous) type = previous.type;
  if (sign === null && previous) sign = previous.delta < 0 ? -1 : 1;

  if (type === null || sign === null) return null;

  const currency = parsedAmount.explicitCurrency
    ? parsedAmount.currency
    : (previous?.currency ?? null);

  return { type, delta: sign * parsedAmount.amount, currency };
}

module.exports = { parseScenarioModification };
