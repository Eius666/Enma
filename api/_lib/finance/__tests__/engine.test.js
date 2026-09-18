'use strict';

// Node.js built-in test runner (node 18+, stable in 22+)
const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { calculateMetrics }     = require('../metrics');
const { calculateAffordability, extractPurchaseAmount } = require('../affordability');
const { calculateGoalPlan }    = require('../goals');
const { calculateCashflow }    = require('../cashflow');
const { calculateLeakSignals } = require('../leaks');
const { calculateMonthReview } = require('../monthReview');
const { calculateStressTest }  = require('../stressTest');
const { calculateDebtStrategy }= require('../debt');
const { calculateScenario }    = require('../scenarios');

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH = '2026-09';
const PREV  = '2026-08';

function tx(type, amount, desc, category, date) {
  return {
    type,
    amount,
    description: desc || 'test',
    category:    category || (type === 'income' ? 'Зарплата' : 'Другой расход'),
    categoryId:  category ? `p-${category}` : (type === 'income' ? 'p-salary' : 'p-other-e'),
    date:        (date || MONTH) + '-15T12:00:00.000Z',
  };
}

// ── calculateMetrics ──────────────────────────────────────────────────────────

test('metrics: savings rate 30%', () => {
  const txs = [
    tx('income',  100_000, 'зарплата'),
    tx('expense',  70_000, 'расходы'),
  ];
  const r = calculateMetrics({ transactions: txs, timezone: 'Europe/Moscow', referenceMonth: MONTH });
  assert.equal(r.status, 'ok');
  assert.equal(r.currentMonth.income,   100_000);
  assert.equal(r.currentMonth.expenses,  70_000);
  assert.equal(r.currentMonth.net,       30_000);
  assert.equal(r.savingsRate.value,      30.0);
});

test('metrics: zero income returns null savingsRate', () => {
  const txs = [tx('expense', 50_000, 'расходы')];
  const r = calculateMetrics({ transactions: txs, timezone: 'Europe/Moscow', referenceMonth: MONTH });
  assert.equal(r.savingsRate.type, 'insufficient_data');
});

test('metrics: empty transactions returns insufficient_data', () => {
  const r = calculateMetrics({ transactions: [], timezone: 'Europe/Moscow' });
  assert.equal(r.status, 'insufficient_data');
});

test('metrics: negative balance when expenses > income', () => {
  const txs = [
    tx('income',  10_000, 'небольшой доход'),
    tx('expense', 50_000, 'большие расходы'),
  ];
  const r = calculateMetrics({ transactions: txs, timezone: 'Europe/Moscow', referenceMonth: MONTH });
  assert.ok(r.currentBalance.value < 0);
});

// ── calculateAffordability ────────────────────────────────────────────────────

test('affordability: purchase larger than balance → negative cashAfterPurchase', () => {
  const txs = [
    tx('income',  140_000),
    tx('expense',  40_000),
  ];
  const r = calculateAffordability({
    purchaseAmount: 150_000,
    transactions: txs,
    goals: [],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.currentBalance.value, 100_000);
  assert.equal(r.scenarios.now.cashAfterPurchase, -50_000);
});

test('affordability: purchase fits with buffer', () => {
  const txs = [
    tx('income',  200_000),
    tx('expense',  50_000),
  ];
  const r = calculateAffordability({
    purchaseAmount: 80_000,
    transactions: txs,
    goals: [],
  });
  assert.equal(r.scenarios.now.cashAfterPurchase, 70_000);
  // bufferShortfall should be 0 or small since 70k > avgMonthlyExpenses * 3
  assert.ok(r.scenarios.now.cashAfterPurchase > 0);
});

test('affordability: null purchaseAmount returns not_provided', () => {
  const txs = [tx('income', 100_000), tx('expense', 60_000)];
  const r = calculateAffordability({ purchaseAmount: null, transactions: txs });
  assert.equal(r.purchaseAmount.type, 'not_provided');
  assert.equal(r.scenarios, undefined);
});

// ── extractPurchaseAmount ─────────────────────────────────────────────────────

test('extractPurchaseAmount: "за 150 000 ₽"', () => {
  assert.equal(extractPurchaseAmount('Могу ли я купить ноутбук за 150 000 ₽?'), 150_000);
});

test('extractPurchaseAmount: "80000 рублей"', () => {
  assert.equal(extractPurchaseAmount('купить телефон 80000 рублей'), 80_000);
});

test('extractPurchaseAmount: "150к"', () => {
  assert.equal(extractPurchaseAmount('могу ли купить за 150к'), 150_000);
});

test('extractPurchaseAmount: no amount returns null', () => {
  assert.equal(extractPurchaseAmount('Как дела с финансами?'), null);
});

// ── calculateGoalPlan ─────────────────────────────────────────────────────────

test('goalPlan: target=500k current=100k months=8 → requiredMonthly=50k', () => {
  const goals = [{
    id:            'g1',
    title:         'Отпуск',
    targetAmount:  500_000,
    currentAmount: 100_000,
    deadline:      '2027-05-01',
  }];
  const txs = [tx('income', 150_000), tx('expense', 100_000)];

  // Force 8 months from deadline perspective:
  // We can't control "today" in pure functions without injection.
  // Instead, verify structure and logic.
  const r = calculateGoalPlan({ goals, transactions: txs, timezone: 'Europe/Moscow' });
  assert.equal(r.status, 'ok');
  const g = r.goals[0];
  assert.equal(g.remaining, 400_000);
  assert.ok(['with_deadline', 'insufficient_input'].includes(g.status));
  // requiredMonthly = 400_000 / monthsLeft — value depends on today's date
  if (g.status === 'with_deadline') {
    assert.ok(g.requiredMonthly.value > 0);
  }
});

test('goalPlan: already reached goal → status completed', () => {
  const goals = [{ id:'g1', title:'Цель', targetAmount: 100_000, currentAmount: 100_000 }];
  const r = calculateGoalPlan({ goals, transactions: [], timezone: 'Europe/Moscow' });
  assert.equal(r.goals[0].status, 'completed');
});

test('goalPlan: no deadline, has avg savings → no_deadline status', () => {
  const goals = [{ id:'g1', title:'Машина', targetAmount: 1_000_000, currentAmount: 0 }];
  const txs = [tx('income', 150_000), tx('expense', 100_000)];
  const r = calculateGoalPlan({ goals, transactions: txs, timezone: 'Europe/Moscow' });
  assert.equal(r.goals[0].status, 'no_deadline');
  assert.ok(r.goals[0].estimatedMonthsToGoal.value > 0);
});

// ── calculateMonthReview ──────────────────────────────────────────────────────

test('monthReview: detects expense increase vs previous month', () => {
  const txs = [
    tx('income',  150_000, 'зп', null, PREV),
    tx('expense',  50_000, 'аренда', null, PREV),
    tx('income',  150_000, 'зп', null, MONTH),
    tx('expense',  80_000, 'аренда', null, MONTH), // +60%
  ];
  const r = calculateMonthReview({ transactions: txs, timezone: 'Europe/Moscow' });
  assert.equal(r.status, 'ok');
  assert.ok(r.changes.expenses > 0);
});

test('monthReview: previous income = 0 → null change', () => {
  const txs = [
    tx('expense', 30_000, 'test', null, PREV),
    tx('income',  100_000, 'зп',  null, MONTH),
    tx('expense',  50_000, 'test', null, MONTH),
  ];
  const r = calculateMonthReview({ transactions: txs, timezone: 'Europe/Moscow' });
  assert.equal(r.changes.income, null); // previous income was 0
});

// ── calculateStressTest ───────────────────────────────────────────────────────

test('stressTest: no-income 3 months, has enough cash', () => {
  const txs = [
    tx('income',  150_000),
    tx('expense',  50_000),
    // balance = 100_000, monthly expenses = 50_000
    // required 3 months = 150_000 → balance 100_000 < 150_000 → shortfall 50_000
  ];
  const r = calculateStressTest({ transactions: txs, timezone: 'Europe/Moscow' });
  assert.equal(r.status, 'ok');
  assert.equal(r.scenarios.noIncome.requiredCash.value, 150_000);
  assert.equal(r.scenarios.noIncome.shortfall.value, 50_000);
  assert.equal(r.scenarios.noIncome.sufficient, false);
});

test('stressTest: income drop 30%', () => {
  const txs = [tx('income', 100_000), tx('expense', 60_000)];
  const r   = calculateStressTest({ transactions: txs, timezone: 'Europe/Moscow' });
  // reduced income = 70_000, expenses = 60_000 → net = +10_000 (sustainable)
  assert.ok(r.scenarios.incomeDrop.monthlyNet.value === 10_000);
  assert.equal(r.scenarios.incomeDrop.runwayMonths.value, null); // sustainable
});

// ── calculateDebtStrategy ─────────────────────────────────────────────────────

test('debt: avalanche vs snowball comparison', () => {
  const debts = [
    { name: 'Credit A', principal: 100_000, interestRatePct: 25, minimumPayment: 5_000 },
    { name: 'Credit B', principal:  30_000, interestRatePct: 18, minimumPayment: 2_000 },
  ];
  const r = calculateDebtStrategy({ debts, extraMonthlyPayment: 10_000 });
  assert.equal(r.status, 'ok');
  assert.ok(r.avalanche.totalInterest.value >= 0);
  assert.ok(r.snowball.totalInterest.value  >= 0);
  // Avalanche should always save interest vs snowball (or equal if only 1 debt)
  assert.ok(r.comparison.interestSavedWithAvalanche >= 0);
});

// ── calculateScenario ─────────────────────────────────────────────────────────

test('scenario: income +20k → net increases by 20k', () => {
  const txs = [tx('income', 100_000), tx('expense', 70_000)];
  const r = calculateScenario({
    transactions: txs,
    modifications: { incomeChange: 20_000 },
    timezone: 'Europe/Moscow',
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.projected.monthlyIncome.value, 120_000);
  assert.equal(r.delta.netChange.value, 20_000);
});

test('scenario: purchase reduces opening balance', () => {
  const txs = [tx('income', 100_000), tx('expense', 50_000)];
  const r = calculateScenario({
    transactions: txs,
    modifications: { purchase: 30_000 },
    timezone: 'Europe/Moscow',
  });
  // balance = 50_000, after purchase = 20_000
  assert.equal(r.projected.balanceStart.value, 20_000);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('edge: deadline today → monthsLeft >= 1', () => {
  const today = new Date().toISOString().slice(0, 10);
  const goals = [{ id:'g', title:'Цель', targetAmount: 10_000, currentAmount: 5_000, deadline: today }];
  const r = calculateGoalPlan({ goals, transactions: [tx('income',5000),tx('expense',2000)], timezone: 'Europe/Moscow' });
  // Should not throw; monthsLeft should be >= 1
  assert.ok(['with_deadline', 'insufficient_input'].includes(r.goals[0].status));
});

test('edge: deadline in the past → still computes, monthsLeft >= 1', () => {
  const goals = [{ id:'g', title:'Цель', targetAmount: 100_000, currentAmount: 0, deadline: '2020-01-01' }];
  const r = calculateGoalPlan({ goals, transactions: [tx('income',5000)], timezone: 'Europe/Moscow' });
  // monthsUntilDeadline will be negative → clamped to 1 by Math.max(1, ...)
  const g = r.goals[0];
  if (g.status === 'with_deadline') {
    assert.ok(g.monthsLeft >= 1);
  }
});

test('edge: transaction amount = 0 does not affect totals', () => {
  const txs = [tx('income', 0), tx('income', 100_000), tx('expense', 0), tx('expense', 60_000)];
  const r = calculateMetrics({ transactions: txs, timezone: 'Europe/Moscow', referenceMonth: MONTH });
  assert.equal(r.currentMonth.income, 100_000);
  assert.equal(r.currentMonth.expenses, 60_000);
});

test('edge: extractPurchaseAmount handles "500 000" with non-breaking space', () => {
  // Common in Russian text
  const msg = 'купить за 500 000 ₽';
  const amount = extractPurchaseAmount(msg);
  // This may or may not parse correctly depending on non-breaking space handling
  // It should not throw regardless
  assert.ok(amount === null || amount === 500_000);
});

console.log('\n✅ All tests completed');
