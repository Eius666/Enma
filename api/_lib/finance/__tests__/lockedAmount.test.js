'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { mockAdmin, createMockDb } = require('../../evals/fixtures');
const fa = require.resolve('../../firebaseAdmin');
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: createMockDb({}), admin: mockAdmin } };

const { hasLockedRub } = require('../lockedAmount');
const { normalizeTransactionsCurrency, needsFx } = require('../normalizeCurrency');
const { calculateCurrentBalance, normalizeTransaction } = require('../../repositories/transactions');

const v2 = (currency, amount, rubAmount, type = 'expense') => ({ schemaVersion: 2, type, currency, amount, rubAmount, date: '2026-09-05' });

test('hasLockedRub requires schemaVersion 2 AND a finite rubAmount', () => {
  assert.equal(hasLockedRub(v2('USD', 1, 86)), true);
  assert.equal(hasLockedRub({ currency: 'USD', amount: 1, rubAmount: 86 }), false); // no schemaVersion
  assert.equal(hasLockedRub({ schemaVersion: 2, amount: 1 }), false);
  assert.equal(hasLockedRub(null), false);
});

test('v2 transactions normalize to RUB via rubAmount with NO rates and NO FX need', () => {
  const txs = [v2('USD', 100, 8600), v2('EUR', 100, 10100), v2('CNY', 500, 6000), v2('RUB', 5000, 5000)];
  assert.equal(needsFx(txs, 'RUB'), false);
  const r = normalizeTransactionsCurrency(txs, 'RUB', null);
  assert.equal(r.ok, true);
  assert.equal(r.transactions.reduce((s, t) => s + t.amount, 0), 29700);
  assert.equal(r.transactions[0].originalCurrency, 'USD');
});

test('v2 rubAmount ignores whatever rates are passed in (history never re-priced)', () => {
  const r = normalizeTransactionsCurrency([v2('USD', 100, 8600)], 'RUB', { RUB: 1, USD: 1 / 1000 });
  assert.equal(r.transactions[0].amount, 8600);
});

test('legacy (no rubAmount) still goes through the legacy resolver + conversion', () => {
  const legacy = { type: 'expense', amount: 100, currency: 'USD', date: '2026-09-05' };
  assert.equal(needsFx([legacy], 'RUB'), true);
  assert.equal(normalizeTransactionsCurrency([legacy], 'RUB', null).ok, false);
  const r = normalizeTransactionsCurrency([legacy], 'RUB', { RUB: 1, USD: 0.01 });
  assert.equal(Math.round(r.transactions[0].amount), 10000);
});

test('balance: v2 income/expense use rubAmount; mixed with legacy RUB', () => {
  const bal = calculateCurrentBalance([
    v2('USD', 1000, 86000, 'income'), v2('EUR', 100, 10100), { type: 'expense', amount: 5000, currency: 'RUB', date: '2026-09-01' },
  ], 'RUB', null);
  assert.equal(bal, 86000 - 10100 - 5000);
});

test('repository normalizeTransaction preserves v2 fields (and adds none for legacy)', () => {
  const n = normalizeTransaction({ id: 'a', data: () => ({ ...v2('USD', 100, 8600), fx: { rateToRub: 86 } }) });
  assert.equal(n.schemaVersion, 2); assert.equal(n.rubAmount, 8600); assert.equal(n.fx.rateToRub, 86);
  const l = normalizeTransaction({ id: 'b', data: () => ({ type: 'expense', amount: 5, currency: 'RUB' }) });
  assert.equal('rubAmount' in l, false);
});
