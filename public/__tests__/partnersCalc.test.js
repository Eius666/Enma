'use strict';

// Tests the SAME module partners.html loads in the browser (public/partners-calc.js)
// — no duplicated logic, no risk of the page and its tests drifting apart.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../partners-calc');

// ── Commission math for real plan prices (section: "30%" math) ─────────────

test('commissionPerPayment: 30% of each real plan price', () => {
  assert.equal(Calc.commissionPerPayment(750, 0.30), 225);   // Pro / month
  assert.equal(Calc.commissionPerPayment(7200, 0.30), 2160); // Pro / year
  assert.equal(Calc.commissionPerPayment(1000, 0.30), 300);  // Premium / month
  assert.equal(Calc.commissionPerPayment(9600, 0.30), 2880); // Premium / year
});

test('commissionPerPayment: respects a custom (per-partner) commission rate', () => {
  assert.equal(Calc.commissionPerPayment(750, 0.50), 375);
  assert.equal(Calc.commissionPerPayment(750, 0.10), 75);
});

test('PLANS mirrors the real backend prices exactly (api/payment/[action].js SBP_PRICES)', () => {
  assert.deepEqual(Calc.planByKey('pro'), { key: 'pro', label: 'Pro', month: 750, year: 7200 });
  assert.deepEqual(Calc.planByKey('premium'), { key: 'premium', label: 'Premium', month: 1000, year: 9600 });
  assert.equal(Calc.priceFor('pro', 'month'), 750);
  assert.equal(Calc.priceFor('pro', 'year'), 7200);
  assert.equal(Calc.priceFor('premium', 'month'), 1000);
  assert.equal(Calc.priceFor('premium', 'year'), 9600);
});

// ── Several consecutive payments (recurring table) ──────────────────────────

test('recurringTable: 1/3/6/12 payments scale linearly from the per-payment commission', () => {
  const rows = Calc.recurringTable(750, 0.30, [1, 3, 6, 12]);
  assert.deepEqual(rows, [
    { payments: 1,  total: 225   },
    { payments: 3,  total: 675   },
    { payments: 6,  total: 1350  },
    { payments: 12, total: 2700  },
  ]);
});

test('recurringTable: defaults to [1,3,6,12] when no counts are given', () => {
  const rows = Calc.recurringTable(1000, 0.30);
  assert.deepEqual(rows.map(r => r.payments), [1, 3, 6, 12]);
});

// ── Calculator funnel totals ─────────────────────────────────────────────────

test('computeFunnel: one-off publication, full funnel narrows stage by stage', () => {
  const r = Calc.computeFunnel({
    audience: 10000, reachPct: 30, clickPct: 5, regPct: 50, buyPct: 5,
    price: 750, rate: 0.30, recurring: false,
  });
  // reach = 10000*0.30 = 3000; clicks = 3000*0.05 = 150;
  // registrations = 150*0.50 = 75; payers = 75*0.05 = 3.75
  assert.equal(r.reach, 3000);
  assert.equal(r.clicks, 150);
  assert.equal(r.registrations, 75);
  assert.equal(r.payers, 3.75);
  assert.equal(r.payments, 3.75);           // one-off: payments == payers
  assert.equal(r.revenue, 3.75 * 750);
  assert.equal(r.commission, 3.75 * 750 * 0.30);
});

test('computeFunnel: recurring mode multiplies payments by avgPayments, not payers', () => {
  const oneOff = Calc.computeFunnel({
    audience: 10000, reachPct: 30, clickPct: 5, regPct: 50, buyPct: 5,
    price: 750, rate: 0.30, recurring: false,
  });
  const recurring = Calc.computeFunnel({
    audience: 10000, reachPct: 30, clickPct: 5, regPct: 50, buyPct: 5,
    price: 750, rate: 0.30, recurring: true, avgPayments: 4,
  });
  assert.equal(recurring.payers, oneOff.payers);         // same funnel up to "paying users"
  assert.equal(recurring.payments, oneOff.payers * 4);
  assert.equal(recurring.commission, oneOff.commission * 4);
});

test('computeFunnel: zero inputs never divide by zero or go negative', () => {
  const r = Calc.computeFunnel({ audience: 0, reachPct: 0, clickPct: 0, regPct: 0, buyPct: 0, price: 750 });
  assert.equal(r.reach, 0);
  assert.equal(r.commission, 0);
});

test('computeFunnel: percentages are clamped to [0,100] — no runaway inputs', () => {
  const r = Calc.computeFunnel({ audience: 1000, reachPct: 500, clickPct: -20, regPct: 100, buyPct: 100, price: 100 });
  assert.equal(r.reach, 1000);   // clamped to 100%
  assert.equal(r.clicks, 0);     // clamped to 0%
});

// ── Demo dataset (dashboard totals) ──────────────────────────────────────────

test('buildDemoDataset: partnerRevenue is exactly payments x price x rate', () => {
  const d = Calc.buildDemoDataset();
  assert.equal(d.revenue, d.payments * d.price);
  assert.equal(d.partnerRevenue, Math.round(d.revenue * d.rate));
});

test('buildDemoDataset: per-source rows sum exactly to the dashboard totals', () => {
  const d = Calc.buildDemoDataset();
  const sumClicks = d.sources.reduce((a, s) => a + s.clicks, 0);
  const sumRegs    = d.sources.reduce((a, s) => a + s.registrations, 0);
  const sumPays    = d.sources.reduce((a, s) => a + s.payments, 0);
  const sumComm    = d.sources.reduce((a, s) => a + s.commission, 0);
  assert.equal(sumClicks, d.clicks);
  assert.equal(sumRegs, d.registrations);
  assert.equal(sumPays, d.payments);
  assert.equal(sumComm, d.partnerRevenue);
});

test('buildDemoDataset: totalEarnedAllTime reconciles pendingPayout + paidOutHistorical', () => {
  const d = Calc.buildDemoDataset();
  assert.equal(d.totalEarnedAllTime, d.pendingPayout + d.paidOutHistorical);
});

// ── splitProportionally: exact-sum guarantee (no rounding drift) ────────────

test('splitProportionally: always sums to exactly the input total, any weights', () => {
  for (const total of [0, 1, 2, 7, 37, 403, 1284]) {
    const parts = Calc.splitProportionally(total, [0.6, 0.25, 0.15]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
    parts.forEach(p => assert.ok(p >= 0 && Number.isInteger(p)));
  }
});

// ── Founding Partners: disabled by default, fully config-driven ────────────

test('FOUNDING_PARTNERS: disabled by default — nothing is hardcoded as "on"', () => {
  assert.equal(Calc.FOUNDING_PARTNERS.ENABLED, false);
  assert.equal(Calc.FOUNDING_PARTNERS.LIMIT, null);
  assert.equal(Calc.FOUNDING_PARTNERS.COMMISSION_PERCENT, null);
  assert.equal(Calc.FOUNDING_PARTNERS.DURATION_MONTHS, null);
});

// ── Attribution / payout facts match the audited backend behavior ──────────

test('ATTRIBUTION_HAS_TIME_LIMIT reflects the real backend (no TTL field exists today)', () => {
  assert.equal(Calc.ATTRIBUTION_HAS_TIME_LIMIT, false);
});

test('HOLD_DAYS matches influencer.js CANCEL_WINDOW_DAYS', () => {
  assert.equal(Calc.HOLD_DAYS, 7);
});

test('MIN_PAYOUT_RUB matches reality: no minimum is enforced by handleAdminReferrals', () => {
  assert.equal(Calc.MIN_PAYOUT_RUB, 0);
});
