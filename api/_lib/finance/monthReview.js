'use strict';

const { round, ROUNDING } = require('./constants');
const { currentYearMonth, prevYearMonth, txYearMonth, txDateStr } = require('./dateHelpers');

// ── Month-over-month review ───────────────────────────────────────────────────
//
// Compares current month to previous month.
// Formula for change%: (current - previous) / previous × 100
//   Edge case: previous = 0 → change is 'new_data' (not a % number)

function pctChange(current, previous) {
  if (previous === 0) return null; // unknown = null, not zero
  return round((current - previous) / previous * 100, ROUNDING.percent);
}

function calculateMonthReview({ transactions, timezone }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const tz        = timezone || 'Europe/Moscow';
  const monthKey  = currentYearMonth(tz);
  const prevMonth = prevYearMonth(monthKey);

  const currentTxs = transactions.filter(t => txYearMonth(t) === monthKey);
  const prevTxs    = transactions.filter(t => txYearMonth(t) === prevMonth);

  function sumByType(txs, type) {
    return txs.filter(t => t.type === type).reduce((s,t) => s+(t.amount||0), 0);
  }

  const curIncome   = round(sumByType(currentTxs, 'income'),  ROUNDING.money);
  const curExpenses = round(sumByType(currentTxs, 'expense'), ROUNDING.money);
  const prevIncome  = round(sumByType(prevTxs, 'income'),     ROUNDING.money);
  const prevExp     = round(sumByType(prevTxs, 'expense'),    ROUNDING.money);

  const curNet    = round(curIncome  - curExpenses, ROUNDING.money);
  const prevNet   = round(prevIncome - prevExp,     ROUNDING.money);
  const curRate   = curIncome  > 0 ? round((curIncome  - curExpenses) / curIncome  * 100, ROUNDING.percent) : null;
  const prevRate  = prevIncome > 0 ? round((prevIncome - prevExp)     / prevIncome * 100, ROUNDING.percent) : null;

  // Category breakdown
  function catBreakdown(txs) {
    const m = {};
    for (const tx of txs.filter(t => t.type === 'expense')) {
      const c = tx.category || (tx.categoryId || '').replace(/^p-/, '') || 'other';
      m[c] = (m[c] || 0) + (tx.amount || 0);
    }
    return m;
  }

  const curCats  = catBreakdown(currentTxs);
  const prevCats = catBreakdown(prevTxs);

  // Category comparison sorted by current amount
  const categoryChanges = Object.entries(curCats)
    .map(([cat, curAmt]) => {
      const prev = prevCats[cat] || 0;
      return {
        category:    cat,
        current:     round(curAmt, ROUNDING.money),
        previous:    round(prev,   ROUNDING.money),
        changePct:   pctChange(curAmt, prev),
      };
    })
    .sort((a, b) => b.current - a.current);

  // Top 3 largest transactions this month
  const largestTransactions = currentTxs
    .filter(t => t.type === 'expense')
    .sort((a, b) => (b.amount||0) - (a.amount||0))
    .slice(0, 3)
    .map(tx => ({
      description: tx.description,
      amount:      round(tx.amount, ROUNDING.money),
      date:        txDateStr(tx),
      category:    tx.category || (tx.categoryId||'').replace(/^p-/,''),
    }));

  // Unusual: expense > 3× category average (simple anomaly signal)
  const unusualTransactions = [];
  const catAvg = {};
  for (const tx of currentTxs.filter(t => t.type === 'expense')) {
    const c = tx.category || 'other';
    if (!catAvg[c]) catAvg[c] = { sum: 0, count: 0 };
    catAvg[c].sum   += tx.amount || 0;
    catAvg[c].count += 1;
  }
  for (const tx of currentTxs.filter(t => t.type === 'expense')) {
    const c   = tx.category || 'other';
    const avg = catAvg[c] ? catAvg[c].sum / catAvg[c].count : 0;
    if (avg > 0 && catAvg[c].count > 1 && (tx.amount||0) > avg * 2.5) {
      unusualTransactions.push({
        description: tx.description,
        amount:      round(tx.amount, ROUNDING.money),
        categoryAvg: round(avg, ROUNDING.money),
        date:        txDateStr(tx),
      });
    }
  }

  return {
    status:   'ok',
    dataType: 'actual',
    currentPeriod:  monthKey,
    previousPeriod: prevMonth,

    current: {
      income:      curIncome,
      expenses:    curExpenses,
      net:         curNet,
      savingsRate: curRate !== null ? { value: curRate, type: 'actual' } : { type: 'insufficient_data' },
    },
    previous: {
      income:      prevIncome,
      expenses:    prevExp,
      net:         prevNet,
      savingsRate: prevRate !== null ? { value: prevRate, type: 'actual' } : { type: 'insufficient_data' },
    },
    changes: {
      income:      pctChange(curIncome, prevIncome),
      expenses:    pctChange(curExpenses, prevExp),
      net:         pctChange(curNet, prevNet),
    },
    categoryChanges,
    largestTransactions,
    unusualTransactions,
  };
}

module.exports = { calculateMonthReview };
