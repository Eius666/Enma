'use strict';

const { round, EMERGENCY_FUND_MONTHS, ROUNDING } = require('./constants');
const { txYearMonth } = require('./dateHelpers');

// ── Purchase amount extraction ────────────────────────────────────────────────
// Tries to extract a numeric amount from the user's message.
// Returns number or null.

function extractPurchaseAmount(message) {
  if (!message || typeof message !== 'string') return null;
  const s = message;

  // "150 000 ₽" / "150000 рублей" / "150 тыс. руб"
  // Lookahead instead of \b — Cyrillic chars are \W in JS, so \b fails after them
  const rubMatch = s.match(/(\d[\d\s ]*(?:[,.]\d+)?)\s*(?:₽|руб(?:лей|ля|ь\.?)?|р\.)(?![а-яёА-ЯЁ])/i);
  if (rubMatch) {
    const n = parseFloat(rubMatch[1].replace(/[\s ]/g, '').replace(',', '.'));
    if (!isNaN(n) && n > 0) return n;
  }

  // "150к" / "150К" / "150 тысяч" / "150k" / "150K"
  // For Cyrillic "к": can't use \b (Cyrillic is \W), use negative lookahead
  const kMatch = s.match(/(\d+(?:[,.]\d+)?)\s*(?:тысяч(?:и)?|тыс\.?|к(?![а-яёА-ЯЁ])|[kK]\b)/i);
  if (kMatch) {
    const n = parseFloat(kMatch[1].replace(',', '.')) * 1000;
    if (!isNaN(n) && n > 0) return n;
  }

  // Bare number preceded by trigger word (за / стоит / стоимостью / куплю / купить)
  const bareMatch = s.match(/(?:за|купить|куплю|стоит|стоимость|стоимостью|потрат)\s+([\d][\d\s]{3,})/i);
  if (bareMatch) {
    const n = parseFloat(bareMatch[1].replace(/[\s ]/g, ''));
    if (!isNaN(n) && n > 0) return n;
  }

  return null;
}

// ── Affordability calculator ──────────────────────────────────────────────────
//
// Inputs (all monetary values in same currency):
//   purchaseAmount       — from user message (optional; if null → multi-scenario omitted)
//   transactions         — full loaded array
//   goals                — loaded goals array
//   safetyBufferMonths   — override (default EMERGENCY_FUND_MONTHS)
//
// Output — facts only, no SAFE/UNSAFE judgment:
//   currentBalance, avgMonthlyExpenses, avgMonthlyIncome,
//   bufferTarget, goalMonthlyCommitment, scenarios { now, afterNextIncome }

function calculateAffordability({ purchaseAmount, transactions, goals, safetyBufferMonths }) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { status: 'insufficient_data', missing: ['transactions'] };
  }

  const bufferMonths = safetyBufferMonths ?? EMERGENCY_FUND_MONTHS;

  const allIncome   = transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0);
  const allExpenses = transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0);
  const currentBalance = round(allIncome - allExpenses, ROUNDING.money);

  const months     = new Set(transactions.map(txYearMonth));
  const monthCount = Math.max(months.size, 1);
  const avgMonthlyExpenses = round(allExpenses / monthCount, ROUNDING.money);
  const avgMonthlyIncome   = round(allIncome   / monthCount, ROUNDING.money);

  const bufferTarget = round(avgMonthlyExpenses * bufferMonths, ROUNDING.money);

  // Goal monthly commitments (only goals with deadlines)
  const now = new Date();
  let goalMonthlyCommitment = 0;
  const goalImpacts = [];
  for (const g of (goals || [])) {
    const remaining = Math.max(0, (g.targetAmount || 0) - (g.currentAmount || 0));
    if (remaining <= 0 || !g.deadline) continue;
    const deadlineMs   = new Date(g.deadline).getTime();
    const monthsLeft   = Math.max(1, Math.round((deadlineMs - now.getTime()) / (30.44 * 86_400_000)));
    const monthly      = round(remaining / monthsLeft, ROUNDING.money);
    goalMonthlyCommitment += monthly;
    goalImpacts.push({ title: g.title, requiredMonthly: monthly, remaining, monthsLeft });
  }
  goalMonthlyCommitment = round(goalMonthlyCommitment, ROUNDING.money);

  const result = {
    status: 'ok',
    currentBalance:         { value: currentBalance,       type: 'actual'     },
    avgMonthlyExpenses:     { value: avgMonthlyExpenses,   type: 'estimated'  },
    avgMonthlyIncome:       { value: avgMonthlyIncome,     type: 'estimated'  },
    bufferTarget:           { value: bufferTarget,         type: 'calculated' },
    goalMonthlyCommitment:  { value: goalMonthlyCommitment,type: 'calculated' },
    goalImpacts,
  };

  // Scenarios only when purchase amount is known
  if (purchaseAmount && purchaseAmount > 0) {
    const cashAfterPurchaseNow          = round(currentBalance - purchaseAmount, ROUNDING.money);
    const cashAfterPurchaseAndExpenses  = round(cashAfterPurchaseNow - avgMonthlyExpenses, ROUNDING.money);
    const bufferShortfallNow            = round(Math.max(0, bufferTarget - cashAfterPurchaseNow), ROUNDING.money);

    const balanceAfterNextIncome        = round(currentBalance + avgMonthlyIncome, ROUNDING.money);
    const cashAfterPurchaseNextIncome   = round(balanceAfterNextIncome - purchaseAmount, ROUNDING.money);
    const bufferShortfallNextIncome     = round(Math.max(0, bufferTarget - cashAfterPurchaseNextIncome), ROUNDING.money);

    result.purchaseAmount = { value: purchaseAmount, type: 'input' };
    result.scenarios = {
      now: {
        cashBefore:              currentBalance,
        cashAfterPurchase:       cashAfterPurchaseNow,
        cashAfterMonthlyExpenses:cashAfterPurchaseAndExpenses,
        bufferShortfall:         bufferShortfallNow,
        dataType:                'calculated',
      },
      afterNextIncome: {
        cashBefore:        balanceAfterNextIncome,
        cashAfterPurchase: cashAfterPurchaseNextIncome,
        bufferShortfall:   bufferShortfallNextIncome,
        dataType:          'estimated',
      },
    };
  } else {
    result.purchaseAmount = { type: 'not_provided' };
  }

  return result;
}

module.exports = { calculateAffordability, extractPurchaseAmount };
