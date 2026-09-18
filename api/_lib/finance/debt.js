'use strict';

const { round, ROUNDING } = require('./constants');

// ── Debt strategy calculator ──────────────────────────────────────────────────
//
// Framework-ready: debts not yet stored in ENMA data model.
// Input: debts[] = [{ name, principal, interestRatePct, minimumPayment, term? }]
// extra: additional monthly payment beyond minimums
//
// Returns avalanche and snowball strategies with:
//   payoff schedule per debt, total interest, months to debt-free, order

function simulateDebt(debts, extra) {
  if (!Array.isArray(debts) || debts.length === 0) return [];
  const items = debts.map(d => ({
    ...d,
    balance:  d.principal,
    paid:     0,
    interest: 0,
    months:   0,
  }));

  let month = 0;
  while (items.some(d => d.balance > 0) && month < 600) {
    month++;
    let available = extra;

    // Monthly interest + minimum payment
    for (const d of items) {
      if (d.balance <= 0) continue;
      const monthlyRate   = d.interestRatePct / 100 / 12;
      const interestCharge = round(d.balance * monthlyRate, ROUNDING.money);
      d.interest  += interestCharge;
      d.balance    = round(d.balance + interestCharge - d.minimumPayment, ROUNDING.money);
      if (d.balance < 0) d.balance = 0;
      if (!d.months) d.months = 0;
      d.months++;
    }

    // Extra payment applied to target debt
    const active = items.filter(d => d.balance > 0);
    if (active.length > 0 && available > 0) {
      const target = active[0]; // caller sorts by strategy
      const payment = Math.min(available, target.balance);
      target.balance = round(target.balance - payment, ROUNDING.money);
      available -= payment;
    }
  }

  return items;
}

// Avalanche: highest APR first
// Snowball:  smallest balance first
function calculateDebtStrategy({ debts, extraMonthlyPayment = 0 }) {
  if (!Array.isArray(debts) || debts.length === 0) {
    return { status: 'insufficient_data', missing: ['debts'] };
  }

  const extra = Math.max(0, extraMonthlyPayment);

  const avalancheOrder  = debts.slice().sort((a,b) => (b.interestRatePct||0) - (a.interestRatePct||0));
  const snowballOrder   = debts.slice().sort((a,b) => (a.principal||0)       - (b.principal||0));

  const ava = simulateDebt(avalancheOrder, extra);
  const sno = simulateDebt(snowballOrder,  extra);

  const totalInterestAva = round(ava.reduce((s,d) => s + d.interest, 0), ROUNDING.money);
  const totalInterestSno = round(sno.reduce((s,d) => s + d.interest, 0), ROUNDING.money);
  const monthsAva        = Math.max(...ava.map(d => d.months));
  const monthsSno        = Math.max(...sno.map(d => d.months));

  return {
    status: 'ok',
    totalPrincipal: round(debts.reduce((s,d) => s+(d.principal||0), 0), ROUNDING.money),
    extraMonthlyPayment: extra,

    avalanche: {
      order:         avalancheOrder.map(d => d.name),
      monthsToPayoff:monthsAva,
      totalInterest: { value: totalInterestAva, type: 'calculated' },
      note:          'highest APR first — minimizes interest paid',
    },
    snowball: {
      order:         snowballOrder.map(d => d.name),
      monthsToPayoff:monthsSno,
      totalInterest: { value: totalInterestSno, type: 'calculated' },
      note:          'smallest balance first — builds momentum',
    },
    comparison: {
      interestSavedWithAvalanche: round(totalInterestSno - totalInterestAva, ROUNDING.money),
      monthsDifference:           Math.abs(monthsAva - monthsSno),
    },
  };
}

module.exports = { calculateDebtStrategy };
