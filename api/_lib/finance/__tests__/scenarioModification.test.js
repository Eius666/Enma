'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { parseScenarioModification } = require('../scenarioModification');

test('SPEC: "буду тратить на 500 больше" → expense_change +500, no explicit currency', () => {
  const r = parseScenarioModification('буду тратить на 500 больше');
  assert.deepEqual(r, { type: 'expense_change', delta: 500, currency: null });
});

test('SPEC: "буду тратить на $500 больше" → expense_change +500 USD', () => {
  const r = parseScenarioModification('буду тратить на $500 больше');
  assert.equal(r.type, 'expense_change');
  assert.equal(r.delta, 500);
  assert.equal(r.currency, 'USD');
});

test('SPEC: "буду откладывать на 20 000 ₽ больше" → savings_change +20000 RUB', () => {
  const r = parseScenarioModification('буду откладывать на 20 000 ₽ больше');
  assert.equal(r.type, 'savings_change');
  assert.equal(r.delta, 20000);
  assert.equal(r.currency, 'RUB');
});

test('SPEC: "доход увеличится на 1000 USD" → income_change +1000 USD', () => {
  const r = parseScenarioModification('доход увеличится на 1000 USD');
  assert.equal(r.type, 'income_change');
  assert.equal(r.delta, 1000);
  assert.equal(r.currency, 'USD');
});

test('SPEC: "расходы уменьшатся на 15 000" → expense_change -15000, no explicit currency', () => {
  const r = parseScenarioModification('расходы уменьшатся на 15 000');
  assert.equal(r.type, 'expense_change');
  assert.equal(r.delta, -15000);
  assert.equal(r.currency, null);
});

test('no monetary amount at all → null', () => {
  assert.equal(parseScenarioModification('а как там погода?'), null);
});

test('amount with no type/direction keyword and no previous turn → null (nothing to anchor it to)', () => {
  assert.equal(parseScenarioModification('500'), null);
});

test('SPEC follow-up: "$500 больше" then "$300" → same type/direction, new amount, same currency', () => {
  const first = parseScenarioModification('А если буду тратить на $500 больше?');
  assert.deepEqual(first, { type: 'expense_change', delta: 500, currency: 'USD' });

  const second = parseScenarioModification('А если на $300?', first);
  assert.deepEqual(second, { type: 'expense_change', delta: 300, currency: 'USD' });
});

test('follow-up without explicit currency this turn inherits currency from previous turn', () => {
  const first = parseScenarioModification('А если буду тратить на $500 больше?');
  const second = parseScenarioModification('А если на 300?', first); // no $ this time
  assert.deepEqual(second, { type: 'expense_change', delta: 300, currency: 'USD' });
});

test('follow-up preserves "less" direction from previous turn', () => {
  const first = parseScenarioModification('расходы уменьшатся на 15 000');
  assert.equal(first.delta, -15000);
  const second = parseScenarioModification('а если на 5000?', first);
  assert.equal(second.type, 'expense_change');
  assert.equal(second.delta, -5000);
});

test('a message that restates type/direction explicitly overrides the previous turn, not just delta', () => {
  const first = parseScenarioModification('расходы увеличатся на 1000');
  assert.equal(first.delta, 1000);
  const second = parseScenarioModification('доход уменьшится на 2000', first);
  assert.equal(second.type, 'income_change');
  assert.equal(second.delta, -2000);
});
