'use strict';

const { round, ROUNDING } = require('./constants');
const { txYearMonth } = require('./dateHelpers');

// ── Stress test engine ────────────────────────────────────────────────────────
//
// Scenario values are parameters — not hardcoded.
// Default scenarios match common financial planning assumptions
// but can be overridden by caller.

const DEFAULT_SCENARIOS = {
  incomeDrop:       { incomeLossPct: 30,  label: 'Доход -30%'              },
  noIncome3Months:  { noIncomeMonths: 3,  label: 'Нет дохода 3 месяца'    },
  emergencyExpense: { amount: 0,          label: 'Внеплановая трата'        },
};

function calculateStressTest({ transactions, timezone, customScenarios }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const tz         = timezone || 'Europe/Moscow';
  const allIncome  = transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0);
  const allExp     = transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0);
  const months     = Math.max(new Set(transactions.map(txYearMonth)).size, 1);

  const currentBalance     = round(allIncome - allExp,     ROUNDING.money);
  const avgMonthlyIncome   = round(allIncome   / months,   ROUNDING.money);
  const avgMonthlyExpenses = round(allExp      / months,   ROUNDING.money);
  const burnRate           = avgMonthlyExpenses;

  const scenarios = customScenarios || DEFAULT_SCENARIOS;
  const results   = {};

  // Scenario: income drop by X%
  if (scenarios.incomeDrop) {
    const { incomeLossPct = 30 } = scenarios.incomeDrop;
    const reducedIncome = round(avgMonthlyIncome * (1 - incomeLossPct / 100), ROUNDING.money);
    const monthlyNet    = round(reducedIncome - avgMonthlyExpenses, ROUNDING.money);
    const runwayMonths  = monthlyNet < 0
      ? round(currentBalance / Math.abs(monthlyNet), ROUNDING.months)
      : null; // positive — no depletion

    results.incomeDrop = {
      label:         scenarios.incomeDrop.label,
      incomeLossPct,
      reducedIncome: { value: reducedIncome, type: 'calculated' },
      monthlyNet:    { value: monthlyNet,    type: 'calculated' },
      runwayMonths:  runwayMonths !== null
        ? { value: runwayMonths, type: 'calculated' }
        : { value: null, note: 'sustainable at reduced income' },
    };
  }

  // Scenario: no income for N months
  if (scenarios.noIncome3Months) {
    const { noIncomeMonths = 3 } = scenarios.noIncome3Months;
    const requiredCash  = round(avgMonthlyExpenses * noIncomeMonths, ROUNDING.money);
    const shortfall     = round(Math.max(0, requiredCash - currentBalance), ROUNDING.money);
    const actualRunway  = burnRate > 0 ? round(currentBalance / burnRate, ROUNDING.months) : null;

    results.noIncome = {
      label:         scenarios.noIncome3Months.label,
      noIncomeMonths,
      requiredCash:  { value: requiredCash,  type: 'calculated' },
      availableCash: { value: currentBalance,type: 'actual'     },
      shortfall:     { value: shortfall,     type: 'calculated' },
      actualRunway:  actualRunway !== null
        ? { value: actualRunway, type: 'calculated' }
        : { type: 'insufficient_data' },
      sufficient:    shortfall === 0,
    };
  }

  // Scenario: emergency expense
  if (scenarios.emergencyExpense) {
    const { amount } = scenarios.emergencyExpense;
    const emergencyAmt = amount > 0 ? amount : round(avgMonthlyExpenses * 2, ROUNDING.money);
    const balanceAfter = round(currentBalance - emergencyAmt, ROUNDING.money);
    const canAbsorb    = balanceAfter >= 0;

    results.emergencyExpense = {
      label:         scenarios.emergencyExpense.label || `Внеплановая трата ${emergencyAmt}`,
      emergencyAmount:{ value: emergencyAmt, type: amount > 0 ? 'input' : 'estimated' },
      balanceAfter:  { value: balanceAfter,  type: 'calculated' },
      canAbsorb,
    };
  }

  return {
    status: 'ok',
    baseline: {
      currentBalance:     { value: currentBalance,     type: 'actual'    },
      avgMonthlyIncome:   { value: avgMonthlyIncome,   type: 'estimated' },
      avgMonthlyExpenses: { value: avgMonthlyExpenses, type: 'estimated' },
      burnRate:           { value: burnRate,            type: 'actual'    },
    },
    scenarios: results,
  };
}

module.exports = { calculateStressTest };
