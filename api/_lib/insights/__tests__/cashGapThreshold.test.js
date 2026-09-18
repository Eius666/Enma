'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// checkSubstantialChange is pure (no Firestore calls), but store.js requires
// ../firebaseAdmin at module load time — mock it so this file needs no real
// credentials.
const { mockAdmin, createMockDb } = require('../../evals/fixtures');
const fa = require.resolve('../../firebaseAdmin');
require.cache[fa] = {
  id: fa, filename: fa, loaded: true,
  exports: { db: createMockDb({}), admin: mockAdmin },
};

const { checkSubstantialChange } = require('../store');

const RATES = { RUB: 1, USD: 0.0118 }; // 5000 RUB ~= 59 USD

function cashGapEvent(gapAmount) {
  return { type: 'finance.cash_gap', facts: { gapAmount } };
}

test('SPEC: RUB user — raw 5000 RUB threshold, no FX needed', () => {
  const existing = cashGapEvent(1000);
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 6001 } }; // delta 5001 >= 5000
  assert.equal(checkSubstantialChange(existing, updated, 'RUB', null), true);
});

test('RUB user — change below threshold does not trigger re-notify', () => {
  const existing = cashGapEvent(1000);
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 4000 } }; // delta 3000 < 5000
  assert.equal(checkSubstantialChange(existing, updated, 'RUB', null), false);
});

test('SPEC: threshold=5000 RUB, event currency=USD → threshold converted (~59 USD) before comparison', () => {
  const existing = cashGapEvent(100);
  // delta = 160 USD, which is >= the converted ~59 USD threshold
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 260 } };
  assert.equal(checkSubstantialChange(existing, updated, 'USD', RATES), true);
});

test('USD user — change smaller than the converted ~59 USD threshold does not trigger re-notify', () => {
  const existing = cashGapEvent(100);
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 130 } }; // delta 30 < ~59
  assert.equal(checkSubstantialChange(existing, updated, 'USD', RATES), false);
});

test('SPEC: threshold FX unavailable for a non-RUB user → no false repeat notification', () => {
  const existing = cashGapEvent(100);
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 100000 } }; // huge delta, but threshold unconvertible
  assert.equal(checkSubstantialChange(existing, updated, 'USD', null), false,
    'must never guess the RUB threshold equals the same number in USD, and must never fabricate a re-notify');
});

test('different event type never triggers cash_gap substantial-change logic', () => {
  const existing = { type: 'finance.category_spike', facts: { gapAmount: 0 } };
  const updated  = { eventType: 'finance.cash_gap', facts: { gapAmount: 100000 } };
  assert.equal(checkSubstantialChange(existing, updated, 'RUB', null), false);
});
