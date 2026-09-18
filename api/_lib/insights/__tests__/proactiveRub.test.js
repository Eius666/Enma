'use strict';

// Proactive detectors run on the RUB budget from locked rubAmount:
// user.currency (input currency) must not influence thresholds, and a v2-only
// dataset must never trigger an FX fetch.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { mockAdmin, createMockDb } = require('../../evals/fixtures');

function load(fixture, spy) {
  const db = createMockDb(fixture);
  const fa = require.resolve('../../firebaseAdmin');
  const er = require.resolve('../../exchangeRates');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  require.cache[er] = { id: er, filename: er, loaded: true, exports: { getExchangeRates: async () => { spy.called = true; return { RUB: 1, USD: 1 / 1000 }; } } };
  for (const m of ['../engine', '../store', '../../repositories/transactions', '../../repositories/goals', '../../repositories/tasks']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
  return { db, engine: require('../engine') };
}

const month = new Date().toISOString().slice(0, 7);
const tx = (id, day, amount, rubAmount, type = 'expense', currency = 'USD') => [`transactions/${id}`, {
  userId: 'u1', schemaVersion: 2, type, currency, amount, rubAmount,
  fx: currency === 'RUB' ? null : { rateToRub: rubAmount / amount }, date: `${month}-${day}`, description: id, categoryId: 'p-groceries',
}];

test('proactive: USD input-currency user with v2 data — no FX fetch, detectors run on rubAmount', async () => {
  const spy = { called: false };
  const fixture = {
    'users/u1': { currency: 'USD', timezone: 'Europe/Moscow', language: 'ru' },
    ...Object.fromEntries([
      tx('inc', '01', 3000, 258000, 'income'),
      tx('e1', '02', 100, 8600), tx('e2', '03', 100, 8600), tx('e3', '04', 100, 8600),
    ]),
  };
  const { engine } = load(fixture, spy);
  const res = await engine.runDetectorsForUser('u1');
  assert.equal(spy.called, false, 'locked rubAmount + RUB thresholds must never need FX');
  assert.equal(res.errors, 0);
});
