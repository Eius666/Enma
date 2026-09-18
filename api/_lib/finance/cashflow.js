'use strict';

const { round, ROUNDING } = require('./constants');
const { txDateStr, txYearMonth, userToday, currentYearMonth, prevYearMonth } = require('./dateHelpers');

// ── Cashflow projection ───────────────────────────────────────────────────────
//
// Builds an event-based cashflow projection for "until end of month".
// Identifies cash gaps (projected balance going negative).
//
// Formula:
//   projected closing balance = opening + expected_income - expected_expenses
//
// For current month:
//   opening = all-time computed balance (from loaded transactions)
//   already-occurred = recorded this month
//   remaining = estimated from previous months' patterns

function calculateCashflow({ transactions, timezone }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const tz        = timezone || 'Europe/Moscow';
  const today     = userToday(tz);
  const monthKey  = currentYearMonth(tz);
  const prevMonth = prevYearMonth(monthKey);

  // All-time balance as opening proxy
  const allIncome   = transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0);
  const allExpenses = transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0);
  const openingBalance = round(allIncome - allExpenses, ROUNDING.money);

  // Current month recorded
  const currentTxs  = transactions.filter(t => txYearMonth(t) === monthKey);
  const monthIncome   = round(currentTxs.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0), ROUNDING.money);
  const monthExpenses = round(currentTxs.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0), ROUNDING.money);

  // Previous month as baseline for remaining projections
  const prevTxs       = transactions.filter(t => txYearMonth(t) === prevMonth);
  const prevIncome    = round(prevTxs.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0), ROUNDING.money);
  const prevExpenses  = round(prevTxs.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0), ROUNDING.money);

  // Estimate remaining of month (fraction of month elapsed)
  const [yr, mo] = monthKey.split('-').map(Number);
  const daysInMonth      = new Date(yr, mo, 0).getDate();
  const dayOfMonth       = parseInt(today.split('-')[2], 10);
  const fractionElapsed  = Math.min(dayOfMonth / daysInMonth, 1);
  const fractionRemaining = Math.max(0, 1 - fractionElapsed);

  const expectedRemainingIncome   = round(prevIncome  * fractionRemaining, ROUNDING.money);
  const expectedRemainingExpenses = round(prevExpenses * fractionRemaining, ROUNDING.money);

  const projectedMonthIncome   = round(monthIncome   + expectedRemainingIncome,   ROUNDING.money);
  const projectedMonthExpenses = round(monthExpenses + expectedRemainingExpenses, ROUNDING.money);
  const projectedClosingBalance = round(openingBalance - monthExpenses - monthIncome
    + projectedMonthIncome - projectedMonthExpenses, ROUNDING.money);

  // Simplified event timeline (recorded transactions sorted by date)
  const events = currentTxs
    .sort((a, b) => txDateStr(a).localeCompare(txDateStr(b)))
    .map(tx => ({
      date:        txDateStr(tx),
      type:        tx.type,
      amount:      tx.amount,
      description: tx.description,
    }));

  // Running balance through recorded events (from opening before this month)
  const preMonthBalance = round(allIncome - allExpenses - monthIncome + monthExpenses, ROUNDING.money);
  let running = preMonthBalance;
  let minBalance     = running;
  let minBalanceDate = null;
  const negPeriods   = [];
  let gapStart       = null;

  for (const ev of events) {
    running += ev.type === 'income' ? ev.amount : -ev.amount;
    running  = round(running, ROUNDING.money);
    if (running < minBalance) {
      minBalance     = running;
      minBalanceDate = ev.date;
    }
    if (running < 0 && !gapStart) {
      gapStart = ev.date;
    } else if (running >= 0 && gapStart) {
      negPeriods.push({ from: gapStart, to: ev.date });
      gapStart = null;
    }
  }
  if (gapStart) negPeriods.push({ from: gapStart, to: today });

  const cashGap = negPeriods.length > 0 || projectedClosingBalance < 0;

  return {
    status:     'ok',
    period:     monthKey,
    today,

    openingBalance: { value: openingBalance, type: 'actual' },

    currentMonth: {
      recordedIncome:   monthIncome,
      recordedExpenses: monthExpenses,
    },
    projections: {
      remainingIncome:   { value: expectedRemainingIncome,   type: 'estimated' },
      remainingExpenses: { value: expectedRemainingExpenses, type: 'estimated' },
      monthTotalIncome:  { value: projectedMonthIncome,      type: 'projected' },
      monthTotalExpenses:{ value: projectedMonthExpenses,    type: 'projected' },
      closingBalance:    { value: projectedClosingBalance,   type: 'projected' },
    },

    cashGap:              cashGap,
    minimumBalance:       { value: minBalance,       date: minBalanceDate, type: 'actual' },
    negativeBalancePeriods: negPeriods,

    events,
    fractionElapsed: round(fractionElapsed * 100, 0),
  };
}

module.exports = { calculateCashflow };
