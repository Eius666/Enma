'use strict';

// ── Shared rounding ───────────────────────────────────────────────────────────

function round(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

// ── Financial constants ───────────────────────────────────────────────────────

const EMERGENCY_FUND_MONTHS = 3;
const LEAK_SPIKE_THRESHOLD_PCT = 30;       // % category growth to flag as spike
const RECURRING_TOLERANCE_PCT  = 0.15;    // ±15% amount tolerance for recurring
const RECURRING_MIN_OCCURRENCES = 2;
const RECURRING_INTERVAL_DAYS = { min: 25, max: 35 };

const SCENARIO_MULTIPLIERS = {
  minimum:     0.7,
  base:        1.0,
  accelerated: 1.3,
};

// Money: 2 dec, percent: 1 dec, months: 1 dec
const ROUNDING = { money: 2, percent: 1, months: 1 };

// Category IDs treated as essential (housing, groceries, transport, health)
const ESSENTIAL_CATEGORY_IDS = new Set([
  'p-housing', 'p-groceries', 'p-transport', 'p-health',
]);

// Category IDs treated as fixed overhead (housing, subscriptions)
const FIXED_CATEGORY_IDS = new Set([
  'p-housing', 'p-subscriptions',
]);

// Fee-like keywords in descriptions
const FEE_KEYWORDS = [
  'комисси', 'commission', 'fee', 'сбор', 'обслуживани', 'service charge',
];

module.exports = {
  round,
  EMERGENCY_FUND_MONTHS,
  LEAK_SPIKE_THRESHOLD_PCT,
  RECURRING_TOLERANCE_PCT,
  RECURRING_MIN_OCCURRENCES,
  RECURRING_INTERVAL_DAYS,
  SCENARIO_MULTIPLIERS,
  ROUNDING,
  ESSENTIAL_CATEGORY_IDS,
  FIXED_CATEGORY_IDS,
  FEE_KEYWORDS,
};
