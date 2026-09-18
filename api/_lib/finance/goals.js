'use strict';

const { round, SCENARIO_MULTIPLIERS, ROUNDING } = require('./constants');
const { txYearMonth, monthsUntilDeadline, currentYearMonth } = require('./dateHelpers');

// ── Goal plan calculator ──────────────────────────────────────────────────────
//
// For each goal:
//   If deadline known:  required monthly = remaining / monthsRemaining
//   If deadline missing but monthlyContribution known: monthsToGoal = remaining / monthly
//   If both unknown: status = INSUFFICIENT_INPUT
//
// Does NOT infer contribution from LLM.

function calculateGoalPlan({ goals, transactions, timezone }) {
  if (!Array.isArray(goals) || goals.length === 0) {
    return { status: 'insufficient_data', missing: ['goals'] };
  }

  const tz        = timezone || 'Europe/Moscow';
  const monthKey  = currentYearMonth(tz);

  // Estimate average savings capacity from transactions (for scenario building)
  let avgSavingsCapacity = null;
  if (Array.isArray(transactions) && transactions.length > 0) {
    const allIncome   = transactions.filter(t => t.type === 'income').reduce((s,t) => s+(t.amount||0), 0);
    const allExpenses = transactions.filter(t => t.type === 'expense').reduce((s,t) => s+(t.amount||0), 0);
    const months      = Math.max(new Set(transactions.map(txYearMonth)).size, 1);
    const avgNet      = (allIncome - allExpenses) / months;
    avgSavingsCapacity = round(Math.max(0, avgNet), ROUNDING.money);
  }

  const plans = goals.map(g => {
    const remaining = round(Math.max(0, (g.targetAmount || 0) - (g.currentAmount || 0)), ROUNDING.money);
    const pctDone   = g.targetAmount > 0
      ? round((g.currentAmount || 0) / g.targetAmount * 100, ROUNDING.percent)
      : 0;

    if (remaining <= 0) {
      return {
        id:       g.id,
        title:    g.title,
        status:   'completed',
        target:   g.targetAmount,
        current:  g.currentAmount,
        pctDone,
        remaining: 0,
      };
    }

    const plan = {
      id:       g.id,
      title:    g.title,
      target:   g.targetAmount,
      current:  g.currentAmount || 0,
      remaining,
      pctDone,
    };

    if (g.deadline) {
      const monthsLeft = Math.max(1, monthsUntilDeadline(g.deadline, tz));
      const requiredMonthly = round(remaining / monthsLeft, ROUNDING.money);
      const requiredWeekly  = round(remaining / (monthsLeft * 4.33), ROUNDING.money);

      plan.deadline          = g.deadline;
      plan.monthsLeft        = monthsLeft;
      plan.requiredMonthly   = { value: requiredMonthly,  type: 'calculated' };
      plan.requiredWeekly    = { value: requiredWeekly,   type: 'calculated' };

      // Feasibility check against average savings capacity
      if (avgSavingsCapacity !== null) {
        plan.feasible = requiredMonthly <= avgSavingsCapacity;
        plan.avgSavingsCapacity = { value: avgSavingsCapacity, type: 'estimated' };
        plan.shortfall = plan.feasible
          ? { value: 0, type: 'calculated' }
          : { value: round(requiredMonthly - avgSavingsCapacity, ROUNDING.money), type: 'calculated' };
      }

      // Scenarios (minimum / base / accelerated) using avg savings capacity
      if (avgSavingsCapacity !== null && avgSavingsCapacity > 0) {
        plan.scenarios = {};
        for (const [key, mult] of Object.entries(SCENARIO_MULTIPLIERS)) {
          const monthlyContrib = round(avgSavingsCapacity * mult, ROUNDING.money);
          const monthsNeeded   = monthlyContrib > 0
            ? Math.ceil(remaining / monthlyContrib)
            : null;
          plan.scenarios[key] = {
            monthlyContribution: monthlyContrib,
            monthsToGoal:        monthsNeeded,
            type:                'projected',
          };
        }
      }

      plan.status = 'with_deadline';
    } else if (avgSavingsCapacity !== null && avgSavingsCapacity > 0) {
      // No deadline — project based on savings capacity
      const monthsToGoal   = Math.ceil(remaining / avgSavingsCapacity);
      const deadlineYear   = new Date();
      deadlineYear.setMonth(deadlineYear.getMonth() + monthsToGoal);
      const estimatedDate  = deadlineYear.toISOString().slice(0, 7);

      plan.estimatedMonthsToGoal = { value: monthsToGoal,   type: 'projected' };
      plan.estimatedCompletion   = { value: estimatedDate,   type: 'projected' };
      plan.avgSavingsCapacity    = { value: avgSavingsCapacity, type: 'estimated' };

      plan.scenarios = {};
      for (const [key, mult] of Object.entries(SCENARIO_MULTIPLIERS)) {
        const monthlyContrib = round(avgSavingsCapacity * mult, ROUNDING.money);
        const months         = monthlyContrib > 0 ? Math.ceil(remaining / monthlyContrib) : null;
        plan.scenarios[key]  = {
          monthlyContribution: monthlyContrib,
          monthsToGoal:        months,
          type:                'projected',
        };
      }

      plan.status = 'no_deadline';
    } else {
      plan.status = 'insufficient_input';
      plan.missing = ['deadline or monthlyContribution or transactionHistory'];
    }

    return plan;
  });

  return { status: 'ok', goals: plans, avgSavingsCapacity };
}

module.exports = { calculateGoalPlan };
