'use strict';

const { round, ROUNDING } = require('./constants');
const { txYearMonth } = require('./dateHelpers');

// ── What-if scenario engine ───────────────────────────────────────────────────
//
// calculateScenario(baseState, modifications)
//   baseState: { avgMonthlyIncome, avgMonthlyExpenses, currentBalance }
//   modifications: { incomeChange?, expenseChange?, purchase?, monthlySavingExtra? }
//
// Returns projected monthly state delta and balance trajectory.

function calculateScenario({ transactions, modifications, timezone }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const allIncome   = transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0);
  const allExpenses = transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0);
  const months      = Math.max(new Set(transactions.map(txYearMonth)).size, 1);

  const baseMonthlyIncome   = round(allIncome   / months, ROUNDING.money);
  const baseMonthlyExpenses = round(allExpenses / months, ROUNDING.money);
  const baseBalance         = round(allIncome - allExpenses, ROUNDING.money);
  const baseNet             = round(baseMonthlyIncome - baseMonthlyExpenses, ROUNDING.money);

  const mods = modifications || {};
  const incomeChange     = mods.incomeChange     || 0; // +/- monthly income
  const expenseChange    = mods.expenseChange    || 0; // +/- monthly expense
  const purchase         = mods.purchase         || 0; // one-time purchase
  const monthlySavingExtra = mods.monthlySavingExtra || 0;

  const newMonthlyIncome   = round(baseMonthlyIncome   + incomeChange,    ROUNDING.money);
  const newMonthlyExpenses = round(baseMonthlyExpenses + expenseChange,   ROUNDING.money);
  const newMonthlySaving   = round(monthlySavingExtra,                    ROUNDING.money);
  const newNet             = round(newMonthlyIncome - newMonthlyExpenses - newMonthlySaving, ROUNDING.money);
  const balanceAfterPurchase = round(baseBalance - purchase, ROUNDING.money);

  // 3-month and 6-month projections
  const proj = (months) => round(balanceAfterPurchase + newNet * months, ROUNDING.money);

  return {
    status: 'ok',
    dataType: 'projected',

    baseline: {
      monthlyIncome:   { value: baseMonthlyIncome,   type: 'actual' },
      monthlyExpenses: { value: baseMonthlyExpenses, type: 'actual' },
      currentBalance:  { value: baseBalance,         type: 'actual' },
      monthlyNet:      { value: baseNet,             type: 'actual' },
    },

    modifications: {
      incomeChange,
      expenseChange,
      purchase,
      monthlySavingExtra,
    },

    projected: {
      monthlyIncome:   { value: newMonthlyIncome,   type: 'projected' },
      monthlyExpenses: { value: newMonthlyExpenses, type: 'projected' },
      monthlyNet:      { value: newNet,             type: 'projected' },
      balanceStart:    { value: balanceAfterPurchase, type: 'projected' },
      balance3Months:  { value: proj(3),  type: 'projected' },
      balance6Months:  { value: proj(6),  type: 'projected' },
      balance12Months: { value: proj(12), type: 'projected' },
    },

    delta: {
      incomeChange:   { value: round(incomeChange,  ROUNDING.money), type: 'input' },
      expenseChange:  { value: round(expenseChange, ROUNDING.money), type: 'input' },
      netChange:      { value: round(newNet - baseNet, ROUNDING.money), type: 'calculated' },
    },
  };
}

module.exports = { calculateScenario };
