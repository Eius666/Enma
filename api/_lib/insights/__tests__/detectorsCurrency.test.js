'use strict';

// Tests the exact pipeline runDetectorsForUser (insights/engine.js) now runs:
// normalizeTransactionsCurrency(rawTransactions, user.currency, rates) →
// detectXxx(ctx with normalized transactions). Detectors themselves are
// untouched — normalization happens once, upstream, so every detector
// inherits correct mixed-currency behavior without duplicating conversion
// logic (spec: "cash-gap должен использовать тот же normalized cashflow...
// не дублировать calculations in detector").

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { normalizeTransactionsCurrency } = require('../../finance/normalizeCurrency');
const {
  detectCashGap,
  detectCategorySpike,
  detectPaymentCluster,
  detectGoalOffTrack,
} = require('../detectors');

const { thisMonthKey, prevMonthKey, dateIn } = require('../../evals/fixtures');

const RATES = { RUB: 1, USD: 100 / 9000 }; // 9000 RUB == 100 USD

test('detectCashGap: mixed-currency history normalized to USD before cashflow projection', () => {
  const P = prevMonthKey();
  const raw = [
    // Prev month: big RUB expenses, no income → all-time balance goes deeply negative in USD terms too
    { type: 'expense', amount: 450000, currency: 'RUB', description: 'Аренда',   date: dateIn(P, 5),  category: 'p-housing' },
    { type: 'expense', amount: 180000, currency: 'RUB', description: 'Продукты', date: dateIn(P, 10), category: 'p-groceries' },
  ];
  const { transactions, ok } = normalizeTransactionsCurrency(raw, 'USD', RATES);
  assert.equal(ok, true);

  const results = detectCashGap({ transactions, timezone: 'Europe/Moscow', lang: 'ru' });
  const upserts = results.filter(r => r.type === 'upsert');
  assert.ok(upserts.length > 0, 'expected a cash_gap event from converted USD balance');
  // 450000+180000 RUB == 7000 USD; facts must be in USD, not raw RUB scale
  assert.ok(Math.abs(upserts[0].facts.currentBalance) < 10000,
    `facts must be USD-scale (~-7000), not RUB-scale, got: ${upserts[0].facts.currentBalance}`);
});

test('detectCategorySpike: previous 90000 RUB vs current 3000 USD → converted comparison, not raw 90000→3000', () => {
  // NOTE: INSIGHTS_CONFIG['finance.category_spike'].minIncreaseAmount (1000) is an
  // absolute floor calibrated in RUB-scale numbers, applied as-is regardless of
  // currency (see Technical Debt). Amounts here are sized to clear that gate in
  // USD terms too, so this test isolates the currency-conversion behavior itself.
  const P = prevMonthKey();
  const M = thisMonthKey();
  const raw = [
    { type: 'expense', amount: 90000, currency: 'RUB', description: 'Продукты', date: dateIn(P, 5), category: 'p-groceries' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary',   date: dateIn(P, 10), category: 'p-salary' },
    { type: 'expense', amount: 3000, currency: 'USD', description: 'Продукты', date: dateIn(M, 5), category: 'p-groceries' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary',   date: dateIn(M, 10), category: 'p-salary' },
  ];
  const { transactions, ok } = normalizeTransactionsCurrency(raw, 'USD', RATES);
  assert.equal(ok, true);

  const results = detectCategorySpike({ transactions, timezone: 'Europe/Moscow', lang: 'ru' });
  const groceries = results.find(r => r.facts.category === 'groceries' || r.facts.category === 'p-groceries');
  assert.ok(groceries, `expected a groceries spike event, got: ${JSON.stringify(results.map(r => r.facts))}`);
  // 90000 RUB -> 1000 USD baseline; current 3000 USD -> +200%, never "90000 -> 3000"
  assert.ok(Math.abs(groceries.facts.baseline - 1000) < 1, `baseline must be ~1000 USD, got: ${groceries.facts.baseline}`);
  assert.ok(Math.abs(groceries.facts.current - 3000) < 1, `current must be 3000 USD, got: ${groceries.facts.current}`);
  assert.ok(Math.abs(groceries.facts.increasePct - 200) < 1, `increase must be +200%, got: ${groceries.facts.increasePct}`);
});

test('detectPaymentCluster: 900000 RUB + 5000 USD forward-dated payments cluster to 15000 USD total, not 905000', () => {
  // NOTE: minTotalAmount (10000) is also an absolute RUB-scale floor — see Technical Debt above.
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const in5days   = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const raw = [
    { type: 'expense', amount: 900000, currency: 'RUB', description: 'Rent',   date: tomorrow, category: 'p-housing' },
    { type: 'expense', amount: 5000,   currency: 'USD', description: 'Insurance', date: in5days, category: 'p-other-e' },
  ];
  const { transactions, ok } = normalizeTransactionsCurrency(raw, 'USD', RATES);
  assert.equal(ok, true);

  const results = detectPaymentCluster({ transactions, timezone: 'Europe/Moscow', lang: 'ru' });
  const upserts = results.filter(r => r.type === 'upsert');
  assert.ok(upserts.length > 0, 'expected a payment_cluster event');
  assert.ok(Math.abs(upserts[0].facts.total - 15000) < 1, `cluster total must be ~15000 USD, got: ${upserts[0].facts.total}`);
});

test('detectGoalOffTrack: savings capacity computed from mixed-currency transactions in one currency', () => {
  const M = thisMonthKey();
  const raw = [
    { type: 'income',  amount: 900000, currency: 'RUB', description: 'Salary',  date: dateIn(M, 10), category: 'p-salary' },
    { type: 'expense', amount: 350,    currency: 'USD', description: 'Expenses', date: dateIn(M, 15), category: 'p-other-e' },
  ];
  const { transactions, ok } = normalizeTransactionsCurrency(raw, 'USD', RATES);
  assert.equal(ok, true);

  const goals = [{
    id: 'goal-1', title: 'Car', targetAmount: 400000, currentAmount: 0,
    deadline: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  }];

  const results = detectGoalOffTrack({ transactions, goals, timezone: 'Europe/Moscow', lang: 'ru' });
  // 900000 RUB -> 10000 USD income; savings capacity is USD-scale (thousands), not RUB-scale (hundred-thousands)
  const upsert = results.find(r => r.type === 'upsert');
  if (upsert) {
    assert.ok(upsert.facts.actualMonthly < 100000, `actualMonthly must be USD-scale, got: ${upsert.facts.actualMonthly}`);
  }
});

// ── Threshold currency conversion (category_spike.minIncreaseAmount,
// payment_cluster.minTotalAmount are RUB-denominated config values) ──────────

const THRESHOLD_RATES = { RUB: 1, USD: 0.0118 }; // 1000 RUB ≈ 11.8 USD

test('SPEC: category_spike threshold (1000 RUB) converts to ~11.8 USD — a $100 spike clears it, which the raw RUB number never would', () => {
  const P = prevMonthKey();
  const M = thisMonthKey();
  const transactions = [
    { type: 'expense', amount: 50,  currency: 'USD', description: 'Кафе', date: dateIn(P, 5), category: 'p-food' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary', date: dateIn(P, 10), category: 'p-salary' },
    { type: 'expense', amount: 150, currency: 'USD', description: 'Кафе', date: dateIn(M, 5), category: 'p-food' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary', date: dateIn(M, 10), category: 'p-salary' },
  ];
  const results = detectCategorySpike({ transactions, timezone: 'Europe/Moscow', lang: 'ru', currency: 'USD', rates: THRESHOLD_RATES });
  const spike = results.find(r => r.facts.category === 'food' || r.facts.category === 'p-food');
  assert.ok(spike, `expected a spike event once threshold is correctly ~11.8 USD, got: ${JSON.stringify(results)}`);
  assert.ok(Math.abs(spike.facts.increase - 100) < 1);
});

test('SPEC: category_spike threshold FX failure → detector skipped, zero false events (never silently drops to percent-only)', () => {
  const P = prevMonthKey();
  const M = thisMonthKey();
  const transactions = [
    { type: 'expense', amount: 50,  currency: 'USD', description: 'Кафе', date: dateIn(P, 5), category: 'p-food' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary', date: dateIn(P, 10), category: 'p-salary' },
    { type: 'expense', amount: 150, currency: 'USD', description: 'Кафе', date: dateIn(M, 5), category: 'p-food' },
    { type: 'income',  amount: 5000, currency: 'USD', description: 'Salary', date: dateIn(M, 10), category: 'p-salary' },
  ];
  // rates=null and currency=USD (!= thresholdCurrency RUB) → cannot convert the threshold
  const results = detectCategorySpike({ transactions, timezone: 'Europe/Moscow', lang: 'ru', currency: 'USD', rates: null });
  assert.deepEqual(results, [], 'threshold-FX-unavailable must skip the detector entirely, not fall back to percentage-only');
});

test('SPEC: category_spike for a RUB user never needs FX for the threshold (thresholdCurrency already RUB)', () => {
  const P = prevMonthKey();
  const M = thisMonthKey();
  const transactions = [
    { type: 'expense', amount: 500,  currency: 'RUB', description: 'Кафе', date: dateIn(P, 5), category: 'p-food' },
    { type: 'income',  amount: 50000, currency: 'RUB', description: 'Salary', date: dateIn(P, 10), category: 'p-salary' },
    { type: 'expense', amount: 2000, currency: 'RUB', description: 'Кафе', date: dateIn(M, 5), category: 'p-food' },
    { type: 'income',  amount: 50000, currency: 'RUB', description: 'Salary', date: dateIn(M, 10), category: 'p-salary' },
  ];
  const results = detectCategorySpike({ transactions, timezone: 'Europe/Moscow', lang: 'ru', currency: 'RUB', rates: null });
  const spike = results.find(r => r.facts.category === 'food' || r.facts.category === 'p-food');
  assert.ok(spike, 'RUB user threshold comparison must work with rates=null (identity, no FX needed)');
});

test('SPEC: payment_cluster threshold (10000 RUB) converts to ~118 USD before comparison', () => {
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const in5days   = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const transactions = [
    { type: 'expense', amount: 70, currency: 'USD', description: 'Rent',   date: tomorrow, category: 'p-housing' },
    { type: 'expense', amount: 60, currency: 'USD', description: 'Bills',  date: in5days,   category: 'p-other-e' },
  ];
  // total = 130 USD; raw config number (10000) would never clear, but ~118 USD threshold does
  const results = detectPaymentCluster({ transactions, timezone: 'Europe/Moscow', lang: 'ru', currency: 'USD', rates: THRESHOLD_RATES });
  const upserts = results.filter(r => r.type === 'upsert');
  assert.ok(upserts.length > 0, `expected a payment_cluster event once threshold is correctly ~118 USD, got: ${JSON.stringify(results)}`);
});

test('SPEC: payment_cluster threshold FX failure → detector skipped, zero false events', () => {
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const in5days   = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const transactions = [
    { type: 'expense', amount: 70, currency: 'USD', description: 'Rent',   date: tomorrow, category: 'p-housing' },
    { type: 'expense', amount: 60, currency: 'USD', description: 'Bills',  date: in5days,   category: 'p-other-e' },
  ];
  const results = detectPaymentCluster({ transactions, timezone: 'Europe/Moscow', lang: 'ru', currency: 'USD', rates: null });
  assert.deepEqual(results, []);
});

test('normalization pipeline: FX unavailable on mixed-currency data → detectors receive empty array, produce no event', () => {
  const raw = [
    { type: 'expense', amount: 9000, currency: 'RUB', description: 'A', date: dateIn(prevMonthKey(), 5), category: 'p-groceries' },
    { type: 'expense', amount: 100,  currency: 'USD', description: 'B', date: dateIn(thisMonthKey(), 5), category: 'p-groceries' },
  ];
  const { ok } = normalizeTransactionsCurrency(raw, 'USD', null); // rates unavailable
  assert.equal(ok, false);

  // Mirrors runDetectorsForUser's safe-degradation branch: on ok=false, run
  // detectors with an empty array rather than raw/unconverted data.
  const results = detectCategorySpike({ transactions: [], timezone: 'Europe/Moscow', lang: 'ru' });
  assert.deepEqual(results, [], 'must produce zero events rather than a wrong one when FX data is missing');
});
