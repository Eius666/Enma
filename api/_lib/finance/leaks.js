'use strict';

const {
  round,
  LEAK_SPIKE_THRESHOLD_PCT,
  RECURRING_TOLERANCE_PCT,
  RECURRING_MIN_OCCURRENCES,
  RECURRING_INTERVAL_DAYS,
  FEE_KEYWORDS,
  ROUNDING,
} = require('./constants');
const { txYearMonth, txDateStr, daysBetween, currentYearMonth, prevYearMonth } = require('./dateHelpers');

// ── Leak detection engine ─────────────────────────────────────────────────────
//
// Returns signals, NOT conclusions. LLM interprets what's worth acting on.
// Signal types:
//   recurring        — same merchant/description, monthly interval, ≥2 occurrences
//   category_spike   — category grew > LEAK_SPIKE_THRESHOLD_PCT vs prev month
//   duplicate        — very similar transaction within 3 days
//   fee              — small service charge / commission
//
// Signal confidence is 0–1. LLM should present with appropriate hedging.

function calculateLeakSignals({ transactions, timezone }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const tz        = timezone || 'Europe/Moscow';
  const monthKey  = currentYearMonth(tz);
  const prevMonth = prevYearMonth(monthKey);

  const expenses     = transactions.filter(t => t.type === 'expense');
  const currentMonthExp = expenses.filter(t => txYearMonth(t) === monthKey);
  const prevMonthExp    = expenses.filter(t => txYearMonth(t) === prevMonth);

  const signals = [];

  // ── 1. Recurring payment detection ─────────────────────────────────────────
  // Group by description prefix (first 15 chars lowercase) and look for monthly pattern.
  const descGroups = {};
  for (const tx of expenses) {
    const key = (tx.description || '').toLowerCase().trim().slice(0, 20);
    if (!key) continue;
    if (!descGroups[key]) descGroups[key] = [];
    descGroups[key].push(tx);
  }

  for (const [key, txs] of Object.entries(descGroups)) {
    if (txs.length < RECURRING_MIN_OCCURRENCES) continue;

    const sorted = txs.slice().sort((a, b) => txDateStr(a).localeCompare(txDateStr(b)));
    let intervalDays = [];
    for (let i = 1; i < sorted.length; i++) {
      intervalDays.push(Math.abs(daysBetween(txDateStr(sorted[i-1]), txDateStr(sorted[i]))));
    }

    const avgInterval = intervalDays.reduce((s,d) => s+d, 0) / intervalDays.length;
    const inMonthlyRange = avgInterval >= RECURRING_INTERVAL_DAYS.min
                        && avgInterval <= RECURRING_INTERVAL_DAYS.max;

    if (!inMonthlyRange) continue;

    const amounts     = sorted.map(t => t.amount || 0);
    const avgAmount   = amounts.reduce((s,a) => s+a, 0) / amounts.length;
    const maxDeviation = Math.max(...amounts.map(a => Math.abs(a - avgAmount) / avgAmount));
    const confidence  = maxDeviation <= RECURRING_TOLERANCE_PCT ? 0.85 : 0.6;

    signals.push({
      type:        'recurring',
      description: sorted[0].description || key,
      occurrences: sorted.length,
      avgAmount:   round(avgAmount, ROUNDING.money),
      avgInterval: Math.round(avgInterval),
      totalPerYear:round(avgAmount * 12, ROUNDING.money),
      confidence,
      latestDate:  txDateStr(sorted[sorted.length - 1]),
    });
  }

  // ── 2. Category spike vs previous month ────────────────────────────────────
  function catSum(txs) {
    const m = {};
    for (const tx of txs) {
      const c = tx.category || (tx.categoryId || '').replace(/^p-/, '') || 'other';
      m[c] = (m[c] || 0) + (tx.amount || 0);
    }
    return m;
  }

  const currentCats = catSum(currentMonthExp);
  const prevCats    = catSum(prevMonthExp);

  for (const [cat, currentAmt] of Object.entries(currentCats)) {
    const prevAmt = prevCats[cat] || 0;
    if (prevAmt === 0) continue; // new category — not a spike against baseline
    const changePct = round((currentAmt - prevAmt) / prevAmt * 100, ROUNDING.percent);
    if (changePct >= LEAK_SPIKE_THRESHOLD_PCT) {
      signals.push({
        type:       'category_spike',
        category:   cat,
        currentAmt: round(currentAmt, ROUNDING.money),
        prevAmt:    round(prevAmt,    ROUNDING.money),
        increase:   round(currentAmt - prevAmt, ROUNDING.money),
        increasePct:changePct,
        confidence: 0.75,
      });
    }
  }

  // ── 3. Duplicate payments (same description + similar amount within 3 days) ─
  const sortedExp = currentMonthExp.slice().sort((a, b) => txDateStr(a).localeCompare(txDateStr(b)));
  for (let i = 0; i < sortedExp.length; i++) {
    for (let j = i + 1; j < sortedExp.length; j++) {
      const a = sortedExp[i];
      const b = sortedExp[j];
      const gap = Math.abs(daysBetween(txDateStr(a), txDateStr(b)));
      if (gap > 3) break;

      const descSimilar = (a.description || '').toLowerCase().slice(0,15) ===
                          (b.description || '').toLowerCase().slice(0,15);
      const amtSimilar  = a.amount && b.amount
        ? Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) <= 0.05
        : false;

      if (descSimilar && amtSimilar) {
        signals.push({
          type:       'duplicate',
          description:a.description,
          amount:     a.amount,
          dates:      [txDateStr(a), txDateStr(b)],
          confidence: 0.80,
        });
      }
    }
  }

  // ── 4. Fee / commission signals ─────────────────────────────────────────────
  for (const tx of currentMonthExp) {
    const lc = (tx.description || '').toLowerCase();
    if (FEE_KEYWORDS.some(kw => lc.includes(kw))) {
      signals.push({
        type:        'fee',
        description: tx.description,
        amount:      tx.amount,
        date:        txDateStr(tx),
        confidence:  0.70,
      });
    }
  }

  return {
    status:  'ok',
    signals,
    signalCount: signals.length,
    period:  monthKey,
  };
}

module.exports = { calculateLeakSignals };
