'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { extractMoneyAmount } = require('../extractMoneyAmount');

test('SPEC: explicit USD is recognized and never treated as the default currency', () => {
  const r = extractMoneyAmount('Могу купить ноутбук за 5000 USD?', 'RUB');
  assert.equal(r.amount, 5000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: explicit $ symbol recognized', () => {
  const r = extractMoneyAmount('Могу купить ноутбук за $5000?', 'RUB');
  assert.equal(r.amount, 5000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: explicit RUB with baseCurrency=USD is NOT reinterpreted as USD', () => {
  const r = extractMoneyAmount('Могу купить за 500 000 ₽?', 'USD');
  assert.equal(r.amount, 500000);
  assert.equal(r.currency, 'RUB');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: "рублей" word form recognized', () => {
  const r = extractMoneyAmount('куплю за 80000 рублей', 'USD');
  assert.equal(r.amount, 80000);
  assert.equal(r.currency, 'RUB');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: "долларов" word form recognized', () => {
  const r = extractMoneyAmount('хочу накопить 20000 долларов', 'RUB');
  assert.equal(r.amount, 20000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: "евро" word form recognized', () => {
  const r = extractMoneyAmount('куплю за 3000 евро', 'RUB');
  assert.equal(r.amount, 3000);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.explicitCurrency, true);
});

test('SPEC: no currency named → falls back to caller-supplied default currency', () => {
  const r = extractMoneyAmount('Могу купить за 5000?', 'USD');
  assert.equal(r.amount, 5000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.explicitCurrency, false);
});

test('goal NLP: "Хочу накопить $20 000" → USD explicit', () => {
  const r = extractMoneyAmount('Хочу накопить $20 000', 'RUB');
  assert.equal(r.amount, 20000);
  assert.equal(r.currency, 'USD');
  assert.equal(r.explicitCurrency, true);
});

test('shorthand "150к" defaults to caller currency, no explicit currency claimed', () => {
  const r = extractMoneyAmount('могу ли купить за 150к', 'RUB');
  assert.equal(r.amount, 150000);
  assert.equal(r.explicitCurrency, false);
});

test('no amount at all returns null', () => {
  assert.equal(extractMoneyAmount('Как дела с финансами?', 'RUB'), null);
});
