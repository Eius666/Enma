'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReportData, stableSortByDate, goalRubValue, goalLabel } = require('../financeReportData');

function tx(overrides = {}) {
  return {
    id: 'tx1', type: 'expense', amount: 100, currency: 'RUB', rubAmount: 100,
    category: 'cat-food', bank: 'Sber', date: '2026-01-15T10:00:00.000Z',
    description: 'Groceries',
    ...overrides,
  };
}

const PERIOD = { key: 'all', from: null, to: null, label: 'За всё время' };

function base(overrides = {}) {
  return {
    allTransactions: [],
    periodTransactions: [],
    goals: [],
    freeBalance: 0,
    rates: null,
    period: PERIOD,
    currency: 'RUB',
    generatedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

// ── Summary math ──────────────────────────────────────────────────────────

test('income/expense/net are summed correctly over the period, excluding goal transfers', () => {
  const txs = [
    tx({ id: '1', type: 'income', amount: 1000 }),
    tx({ id: '2', type: 'expense', amount: 300 }),
    tx({ id: '3', type: 'goal_deposit', amount: 200, goalId: 'g1' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 500 }));
  assert.equal(data.summary.income, 1000);
  assert.equal(data.summary.expense, 300);
  assert.equal(data.summary.net, 700);
  assert.equal(data.summary.freeBalance, 500);
});

test('Free Balance is taken as-is from the caller, never recomputed from the period transactions', () => {
  // freeBalance deliberately does NOT match what summing periodTransactions
  // would produce — proving this module trusts the caller's authoritative
  // figure (txRepo.calculateCurrentBalance over ALL transactions) rather
  // than silently recalculating its own, inconsistent number.
  const data = buildReportData(base({ periodTransactions: [tx({ type: 'income', amount: 1 })], freeBalance: 999999 }));
  assert.equal(data.summary.freeBalance, 999999);
});

// ── Goal semantics (PHASE 4): deposits/withdrawals never counted as consumer spend/income ──

test('goal_deposit/goal_withdraw never appear in expense/income category breakdowns', () => {
  const txs = [
    tx({ id: '1', type: 'goal_deposit', amount: 500, goalId: 'g1', category: 'cat-savings' }),
    tx({ id: '2', type: 'goal_withdraw', amount: 200, goalId: 'g1', category: 'cat-savings' }),
    tx({ id: '3', type: 'expense', amount: 50, category: 'cat-food' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.equal(data.expenseByCategory.length, 1);
  assert.equal(data.expenseByCategory[0].category, 'food');
  assert.equal(data.incomeByCategory.length, 0);
});

test('goal_deposit/goal_withdraw DO appear in the full transaction history, labeled distinctly', () => {
  const txs = [
    tx({ id: '1', type: 'goal_deposit', amount: 500, goalId: 'g1' }),
    tx({ id: '2', type: 'goal_withdraw', amount: 200, goalId: 'g1' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.equal(data.transactions.length, 2);
  const deposit = data.transactions.find(t => t.type === 'goal_deposit');
  const withdraw = data.transactions.find(t => t.type === 'goal_withdraw');
  assert.equal(deposit.label, 'Пополнение цели');
  assert.equal(withdraw.label, 'Снятие из цели');
  assert.equal(deposit.category, null, 'goal transfers are not categorized as spending/income');
});

test('goalLabel: returns null for ordinary expense/income (renderer must not mislabel them)', () => {
  assert.equal(goalLabel(tx({ type: 'expense' })), null);
  assert.equal(goalLabel(tx({ type: 'income' })), null);
});

// ── Category/monthly/bank breakdowns ────────────────────────────────────

test('category breakdown computes percentages relative to the category total, sorted descending', () => {
  const txs = [
    tx({ id: '1', type: 'expense', amount: 300, category: 'cat-food' }),
    tx({ id: '2', type: 'expense', amount: 100, category: 'cat-transport' }),
    tx({ id: '3', type: 'expense', amount: 300, category: 'cat-food' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.deepEqual(data.expenseByCategory.map(c => c.category), ['food', 'transport']);
  assert.equal(data.expenseByCategory[0].amount, 600);
  assert.equal(data.expenseByCategory[0].pct, 85.7); // 600/700
  assert.equal(data.expenseByCategory[1].amount, 100);
});

test('a transaction with no category falls back to "Без категории"', () => {
  const txs = [tx({ id: '1', type: 'expense', amount: 50, category: undefined, categoryId: undefined })];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.equal(data.expenseByCategory[0].category, 'Без категории');
});

test('monthly trend groups by year-month and sorts ascending', () => {
  const txs = [
    tx({ id: '1', type: 'expense', amount: 100, date: '2026-03-01T00:00:00.000Z' }),
    tx({ id: '2', type: 'income',  amount: 200, date: '2026-01-01T00:00:00.000Z' }),
    tx({ id: '3', type: 'expense', amount: 50,  date: '2026-01-15T00:00:00.000Z' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.deepEqual(data.monthlyTrend.map(m => m.yearMonth), ['2026-01', '2026-03']);
  assert.equal(data.monthlyTrend[0].income, 200);
  assert.equal(data.monthlyTrend[0].expense, 50);
});

test('bank breakdown ignores transactions with no bank set, and goal transfers', () => {
  const txs = [
    tx({ id: '1', type: 'expense', amount: 100, bank: 'Tinkoff' }),
    tx({ id: '2', type: 'income',  amount: 500, bank: 'Tinkoff' }),
    tx({ id: '3', type: 'expense', amount: 999, bank: undefined }),
    tx({ id: '4', type: 'goal_deposit', amount: 300, bank: 'Tinkoff', goalId: 'g1' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.equal(data.byBank.length, 1);
  assert.equal(data.byBank[0].bank, 'Tinkoff');
  assert.equal(data.byBank[0].income, 500);
  assert.equal(data.byBank[0].expense, 100);
  assert.equal(data.byBank[0].net, 400);
});

// ── Multi-currency / historical rubAmount (PHASE 4) ─────────────────────

test('each transaction keeps its original amount/currency AND the locked rubAmount, side by side', () => {
  const txs = [tx({ id: '1', type: 'expense', amount: 90, currency: 'RUB', rubAmount: 90, originalAmount: 1, originalCurrency: 'USD' })];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  const row = data.transactions[0];
  assert.equal(row.amount, 90);
  assert.equal(row.currency, 'RUB');
  assert.equal(row.rubAmount, 90);
  assert.equal(row.originalAmount, 1);
  assert.equal(row.originalCurrency, 'USD');
});

// ── Goals / savings (cost-basis contract) ───────────────────────────────

test('goalRubValue: uses currentAmountRub (cost basis) when present, never a fresh FX conversion', () => {
  const g = { currentAmountRub: 5000, currentAmount: 999, currency: 'USD' };
  assert.equal(goalRubValue(g, { USD: 0.011, RUB: 1 }), 5000);
});

test('goalRubValue: falls back to live conversion ONLY for a legacy goal missing currentAmountRub', () => {
  const g = { currentAmount: 100, currency: 'USD' };
  const rub = goalRubValue(g, { USD: 0.011, RUB: 1 });
  assert.ok(Math.abs(rub - 100 / 0.011) < 0.01);
});

test('goalRubValue: returns null (never guesses) when conversion is needed but no rates are available', () => {
  const g = { currentAmount: 100, currency: 'USD' };
  assert.equal(goalRubValue(g, null), null);
});

test('Total Funds = Free Balance + Savings Balance (the ENMA invariant), computed from goals\' currentAmountRub', () => {
  const goals = [
    { id: 'g1', title: 'Car', targetAmount: 10000, currentAmount: 3000, currency: 'RUB', currentAmountRub: 3000 },
    { id: 'g2', title: 'Trip', targetAmount: 2000, currentAmount: 2000, currency: 'RUB', currentAmountRub: 2000 },
  ];
  const data = buildReportData(base({ goals, freeBalance: 1000 }));
  assert.equal(data.summary.savingsBalance, 5000);
  assert.equal(data.summary.totalFunds, 6000);
});

test('Total Funds is null (never a wrong number) when a legacy goal\'s RUB value truly cannot be determined', () => {
  const goals = [{ id: 'g1', title: 'Legacy', targetAmount: 100, currentAmount: 50, currency: 'USD' }];
  const data = buildReportData(base({ goals, freeBalance: 1000, rates: null }));
  assert.equal(data.summary.savingsUnknown, true);
  assert.equal(data.summary.totalFunds, null);
});

test('activeGoalsCount counts only goals not yet fully funded', () => {
  const goals = [
    { id: 'g1', title: 'Done', targetAmount: 100, currentAmount: 100, currentAmountRub: 100 },
    { id: 'g2', title: 'Not done', targetAmount: 100, currentAmount: 10, currentAmountRub: 10 },
  ];
  const data = buildReportData(base({ goals, freeBalance: 0 }));
  assert.equal(data.summary.activeGoalsCount, 1);
});

test('a goal\'s relatedOps only includes transactions tagged with its own goalId', () => {
  const txs = [
    tx({ id: '1', type: 'goal_deposit', amount: 100, goalId: 'g1' }),
    tx({ id: '2', type: 'goal_deposit', amount: 200, goalId: 'g2' }),
  ];
  const goals = [{ id: 'g1', title: 'Car', targetAmount: 1000, currentAmount: 100, currentAmountRub: 100 }];
  const data = buildReportData(base({ periodTransactions: txs, goals, freeBalance: 0 }));
  assert.equal(data.goals[0].relatedOps.length, 1);
  assert.equal(data.goals[0].relatedOps[0].amount, 100);
});

// ── Sorting stability ────────────────────────────────────────────────────

test('stableSortByDate: equal timestamps are broken by id, deterministically, not left to array order', () => {
  const txs = [
    tx({ id: 'b', date: '2026-01-01T00:00:00.000Z' }),
    tx({ id: 'a', date: '2026-01-01T00:00:00.000Z' }),
  ];
  const sortedDesc = stableSortByDate(txs, 'desc');
  const sortedDescAgain = stableSortByDate([...txs].reverse(), 'desc');
  assert.deepEqual(sortedDesc.map(t => t.id), sortedDescAgain.map(t => t.id));
});

test('transactions in the output are sorted newest-first', () => {
  const txs = [
    tx({ id: '1', date: '2026-01-01T00:00:00.000Z' }),
    tx({ id: '2', date: '2026-03-01T00:00:00.000Z' }),
    tx({ id: '3', date: '2026-02-01T00:00:00.000Z' }),
  ];
  const data = buildReportData(base({ periodTransactions: txs, freeBalance: 0 }));
  assert.deepEqual(data.transactions.map(t => t.date.slice(0, 10)), ['2026-03-01', '2026-02-01', '2026-01-01']);
});

// ── Empty history ────────────────────────────────────────────────────────

test('an empty transaction list produces a valid, zeroed-out report, not an error', () => {
  const data = buildReportData(base({ freeBalance: 0 }));
  assert.equal(data.summary.income, 0);
  assert.equal(data.summary.expense, 0);
  assert.equal(data.summary.transactionCount, 0);
  assert.deepEqual(data.expenseByCategory, []);
  assert.deepEqual(data.transactions, []);
});

// ── meta ─────────────────────────────────────────────────────────────────

test('meta.transactionCount reflects the period-scoped count, not all-time', () => {
  const periodTransactions = [tx({ id: '1' })];
  const allTransactions = [tx({ id: '1' }), tx({ id: '2', date: '2020-01-01T00:00:00.000Z' })];
  const data = buildReportData(base({ allTransactions, periodTransactions, freeBalance: 0 }));
  assert.equal(data.meta.transactionCount, 1);
});
