'use strict';

const {
  round,
  EMERGENCY_FUND_MONTHS,
  ESSENTIAL_CATEGORY_IDS,
  FIXED_CATEGORY_IDS,
  ROUNDING,
} = require('./constants');
const { currentYearMonth, prevYearMonth, txYearMonth } = require('./dateHelpers');

// ── Core financial metrics ────────────────────────────────────────────────────
//
// Formula reference:
//   netCashflow    = income - expenses
//   savingsRate    = (income - expenses) / income × 100   [when income > 0]
//   burnRate       = average monthly expenses over data window
//   runwayMonths   = currentBalance / monthlyEssentialExpenses
//   savingsAmount  = max(0, netCashflow)

function calculateMetrics({ transactions, timezone, referenceMonth }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const monthKey  = referenceMonth || currentYearMonth(timezone || 'Europe/Moscow');
  const prevMonth = prevYearMonth(monthKey);

  const currentTxs = transactions.filter(t => txYearMonth(t) === monthKey);
  const prevTxs    = transactions.filter(t => txYearMonth(t) === prevMonth);

  function sumBy(txs, type) {
    return txs.filter(t => t.type === type).reduce((s, t) => s + (t.amount || 0), 0);
  }

  const currentIncome   = round(sumBy(currentTxs, 'income'),  ROUNDING.money);
  const currentExpenses = round(sumBy(currentTxs, 'expense'), ROUNDING.money);
  const prevIncome      = round(sumBy(prevTxs, 'income'),     ROUNDING.money);
  const prevExpenses    = round(sumBy(prevTxs, 'expense'),    ROUNDING.money);
  const allIncome       = round(transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0),  ROUNDING.money);
  const allExpenses     = round(transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0), ROUNDING.money);

  const netCashflow   = round(currentIncome - currentExpenses, ROUNDING.money);
  const savingsAmount = round(Math.max(0, netCashflow), ROUNDING.money);

  const savingsRate = currentIncome > 0
    ? round((currentIncome - currentExpenses) / currentIncome * 100, ROUNDING.percent)
    : null;

  // Months represented in the data window
  const months     = new Set(transactions.map(txYearMonth));
  const monthCount = Math.max(months.size, 1);

  const avgMonthlyIncome   = round(allIncome   / monthCount, ROUNDING.money);
  const avgMonthlyExpenses = round(allExpenses / monthCount, ROUNDING.money);

  // burnRate = average monthly expenses (consistent definition across all skills)
  const burnRate = avgMonthlyExpenses;

  // All-time balance (computed from loaded transactions — best available proxy)
  const currentBalance = round(allIncome - allExpenses, ROUNDING.money);

  // Essential expenses (current month)
  const essentialCurrentMonth = round(
    currentTxs
      .filter(t => t.type === 'expense' && ESSENTIAL_CATEGORY_IDS.has(t.categoryId))
      .reduce((s, t) => s + (t.amount || 0), 0),
    ROUNDING.money
  );
  const monthlyEssential = essentialCurrentMonth > 0
    ? essentialCurrentMonth
    : currentExpenses; // fallback: treat all as essential when no category data

  // Financial runway
  const runwayMonths = monthlyEssential > 0
    ? round(Math.max(0, currentBalance) / monthlyEssential, ROUNDING.months)
    : null;

  // Emergency fund
  const emergencyFundTarget = round(monthlyEssential * EMERGENCY_FUND_MONTHS, ROUNDING.money);
  const emergencyFundStatus = currentBalance >= emergencyFundTarget
    ? 'adequate'
    : currentBalance > 0
      ? 'partial'
      : 'critical';

  // Fixed expense ratio (housing + subscriptions / total expenses)
  const fixedCurrentMonth = currentTxs
    .filter(t => t.type === 'expense' && FIXED_CATEGORY_IDS.has(t.categoryId))
    .reduce((s, t) => s + (t.amount || 0), 0);
  const fixedExpenseRatio = currentExpenses > 0
    ? round(fixedCurrentMonth / currentExpenses * 100, ROUNDING.percent)
    : null;

  // Top categories (current month expenses)
  const catMap = {};
  for (const tx of currentTxs.filter(t => t.type === 'expense')) {
    const cat = tx.category || (tx.categoryId || '').replace(/^p-/, '') || 'other';
    catMap[cat] = (catMap[cat] || 0) + (tx.amount || 0);
  }
  const topCategories = Object.entries(catMap)
    .map(([name, amount]) => ({ name, amount: round(amount, ROUNDING.money) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return {
    status:   'ok',
    dataType: 'actual',
    period:   monthKey,

    currentMonth: {
      income:   currentIncome,
      expenses: currentExpenses,
      net:      netCashflow,
    },
    prevMonth: {
      income:   prevIncome,
      expenses: prevExpenses,
      net:      round(prevIncome - prevExpenses, ROUNDING.money),
    },
    currentBalance: { value: currentBalance, type: 'actual' },
    averages: {
      monthlyIncome:   avgMonthlyIncome,
      monthlyExpenses: avgMonthlyExpenses,
    },
    savingsRate:   savingsRate !== null
      ? { value: savingsRate,   type: 'actual' }
      : { type: 'insufficient_data' },
    savingsAmount: { value: savingsAmount, type: 'actual' },
    burnRate:      { value: burnRate,      type: 'actual' },
    essentialExpenses: {
      value: monthlyEssential,
      type:  essentialCurrentMonth > 0 ? 'actual' : 'estimated',
    },
    runwayMonths: runwayMonths !== null
      ? { value: runwayMonths, type: 'calculated' }
      : { type: 'insufficient_data' },
    emergencyFund: {
      target: { value: emergencyFundTarget, type: 'calculated' },
      status: emergencyFundStatus,
    },
    fixedExpenseRatio: fixedExpenseRatio !== null
      ? { value: fixedExpenseRatio, type: 'actual' }
      : { type: 'insufficient_data' },
    topCategories,
    monthCount,
  };
}

module.exports = { calculateMetrics };
