'use strict';

// Pure data-shaping layer for the finance PDF export. Takes ALREADY-CORRECT
// numbers (normalized currency, locked historical rubAmount, the real
// calculateCurrentBalance figure) and arranges them into exactly what the
// PDF renderer needs — it never recomputes a balance, converts a currency,
// or resolves a legacy record's currency itself. That is deliberate: this
// module has zero Firestore/FX/pdfkit dependencies, so it's fast and
// trivial to unit-test, and it structurally cannot drift from the
// authoritative finance contracts in api/_lib/repositories/transactions.js
// and api/_lib/finance/normalizeCurrency.js, which the caller
// (exportFinancePdf.js) is responsible for calling first.

const { round, ROUNDING } = require('../finance/constants');
const { txYearMonth, txDateStr } = require('../finance/dateHelpers');

const GOAL_TX_TYPES = new Set(['goal_deposit', 'goal_withdraw']);

function categoryLabel(tx) {
  const raw = tx.category || tx.categoryId || '';
  const cleaned = String(raw).replace(/^cat-/, '').replace(/^p-/, '').trim();
  return cleaned || 'Без категории';
}

// Stable sort: primary key via `cmp`, ties broken by `id` so two
// transactions with an identical timestamp always come out in the same
// relative order on every run (never left to whatever order Array.sort's
// underlying algorithm happens to produce for equal keys).
function stableSortByDate(transactions, direction) {
  const withIndex = transactions.map((t, i) => ({ t, i }));
  withIndex.sort((a, b) => {
    const da = txDateStr(a.t);
    const db = txDateStr(b.t);
    if (da !== db) return direction === 'desc' ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
    const ida = a.t.id || '';
    const idb = b.t.id || '';
    if (ida !== idb) return direction === 'desc' ? (ida < idb ? 1 : -1) : (ida < idb ? -1 : 1);
    return a.i - b.i; // final fallback: original array order — fully deterministic
  });
  return withIndex.map(x => x.t);
}

function sumBy(transactions, type) {
  return round(
    transactions.filter(t => t.type === type).reduce((s, t) => s + (t.amount || 0), 0),
    ROUNDING.money
  );
}

function categoryBreakdown(transactions, type) {
  const totals = new Map();
  for (const t of transactions) {
    if (t.type !== type) continue;
    const cat = categoryLabel(t);
    totals.set(cat, (totals.get(cat) || 0) + (t.amount || 0));
  }
  const grandTotal = [...totals.values()].reduce((s, v) => s + v, 0);
  return [...totals.entries()]
    .map(([category, amount]) => ({
      category,
      amount: round(amount, ROUNDING.money),
      pct: grandTotal > 0 ? round((amount / grandTotal) * 100, ROUNDING.percent) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

function monthlyTrend(transactions) {
  const byMonth = new Map();
  for (const t of transactions) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const ym = txYearMonth(t);
    if (!byMonth.has(ym)) byMonth.set(ym, { income: 0, expense: 0 });
    const bucket = byMonth.get(ym);
    if (t.type === 'income') bucket.income += t.amount || 0;
    else bucket.expense += t.amount || 0;
  }
  return [...byMonth.entries()]
    .map(([yearMonth, v]) => ({
      yearMonth,
      income: round(v.income, ROUNDING.money),
      expense: round(v.expense, ROUNDING.money),
    }))
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function bankBreakdown(transactions) {
  const byBank = new Map();
  for (const t of transactions) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    if (!t.bank) continue;
    if (!byBank.has(t.bank)) byBank.set(t.bank, { income: 0, expense: 0 });
    const bucket = byBank.get(t.bank);
    if (t.type === 'income') bucket.income += t.amount || 0;
    else bucket.expense += t.amount || 0;
  }
  return [...byBank.entries()]
    .map(([bank, v]) => ({
      bank,
      income: round(v.income, ROUNDING.money),
      expense: round(v.expense, ROUNDING.money),
      net: round(v.income - v.expense, ROUNDING.money),
    }))
    .sort((a, b) => (b.income + b.expense) - (a.income + a.expense));
}

// A goal's current RUB value: currentAmountRub is the atomically-maintained
// cost basis (api/_lib/finance/goalTransfer.js) — the SAME figure
// src/components/FinanceList.tsx uses for its "Отложено" line and the SAME
// one the Free Balance + Savings Balance = Total Funds invariant relies
// on. Falls back to a live conversion ONLY for a goal that predates this
// field and has never been touched since — identical fallback to
// FinanceList.tsx's savingsBalance and goalTransfer.js's closeGoal.
function goalRubValue(goal, rates) {
  if (typeof goal.currentAmountRub === 'number' && Number.isFinite(goal.currentAmountRub)) {
    return goal.currentAmountRub;
  }
  const { convertCurrency } = require('../convertCurrency');
  if (!rates) return null; // cannot state a real number — caller must treat as unknown, never guess
  return convertCurrency(goal.currentAmount || 0, goal.currency || 'RUB', 'RUB', rates);
}

function goalLabel(tx) {
  if (tx.type === 'goal_deposit') return 'Пополнение цели';
  if (tx.type === 'goal_withdraw') return 'Снятие из цели';
  return null;
}

/**
 * @param {object} input
 * @param {object[]} input.allTransactions - ALL of the user's transactions, already currency-normalized into `currency`.
 * @param {object[]} input.periodTransactions - the subset of allTransactions within the requested period (same normalization).
 * @param {object[]} input.goals - normalized goals (repositories/goals.js), each with currentAmountRub attached if present.
 * @param {number} input.freeBalance - result of txRepo.calculateCurrentBalance(allTransactions, currency, rates) — never recomputed here.
 * @param {object|null} input.rates - FX rates, only used as the legacy-goal fallback in goalRubValue.
 * @param {{key:string, from:string|null, to:string|null, label:string}} input.period
 * @param {string} input.currency
 * @param {Date} input.generatedAt
 */
function buildReportData(input) {
  const {
    allTransactions, periodTransactions, goals,
    freeBalance, rates, period, currency, generatedAt,
  } = input;

  const income  = sumBy(periodTransactions, 'income');
  const expense = sumBy(periodTransactions, 'expense');
  const net     = round(income - expense, ROUNDING.money);

  let savingsBalance = 0;
  let savingsUnknown = false;
  const goalRows = goals.map(g => {
    const rub = goalRubValue(g, rates);
    if (rub === null) savingsUnknown = true;
    else savingsBalance += rub;

    const relatedOps = periodTransactions
      .filter(t => GOAL_TX_TYPES.has(t.type) && t.goalId === g.id)
      .map(t => ({
        date: txDateStr(t),
        label: goalLabel(t),
        amount: t.amount,
        currency: t.currency,
        rubAmount: typeof t.rubAmount === 'number' ? t.rubAmount : null,
      }));

    return {
      id: g.id,
      title: g.title || 'Без названия',
      targetAmount: g.targetAmount || 0,
      currentAmount: g.currentAmount || 0,
      currency: g.currency || 'RUB',
      currentAmountRub: rub,
      pct: g.targetAmount > 0 ? round(((g.currentAmount || 0) / g.targetAmount) * 100, ROUNDING.percent) : 0,
      deadline: g.deadline || null,
      relatedOps,
    };
  });
  savingsBalance = round(savingsBalance, ROUNDING.money);
  const totalFunds = savingsUnknown ? null : round(freeBalance + savingsBalance, ROUNDING.money);

  const transactions = stableSortByDate(periodTransactions, 'desc').map(t => ({
    date:        t.date || '',
    description: t.description || '',
    type:        t.type,
    label:       goalLabel(t), // non-null only for goal_deposit/goal_withdraw — renderer uses this INSTEAD OF "Расход"/"Доход"
    category:    GOAL_TX_TYPES.has(t.type) ? null : categoryLabel(t),
    bank:        t.bank || '',
    amount:      t.amount,
    currency:    t.currency,
    rubAmount:   typeof t.rubAmount === 'number' ? t.rubAmount : null,
    originalAmount:   t.originalAmount,
    originalCurrency: t.originalCurrency,
  }));

  return {
    meta: {
      currency,
      period,
      generatedAtISO: generatedAt.toISOString(),
      transactionCount: periodTransactions.length,
    },
    summary: {
      income,
      expense,
      net,
      freeBalance: round(freeBalance, ROUNDING.money),
      savingsBalance,
      savingsUnknown,
      totalFunds,
      transactionCount: periodTransactions.length,
      activeGoalsCount: goalRows.filter(g => g.targetAmount > (g.currentAmount || 0)).length,
    },
    expenseByCategory: categoryBreakdown(periodTransactions, 'expense'),
    incomeByCategory:  categoryBreakdown(periodTransactions, 'income'),
    monthlyTrend: monthlyTrend(periodTransactions),
    byBank: bankBreakdown(periodTransactions),
    goals: goalRows,
    transactions,
  };
}

module.exports = { buildReportData, categoryLabel, stableSortByDate, goalRubValue, goalLabel };
