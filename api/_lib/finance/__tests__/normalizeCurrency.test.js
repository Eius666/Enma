'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { normalizeTransactionsCurrency, needsFx, normalizeGoalsCurrency, goalsNeedFx } = require('../normalizeCurrency');

const RATES = { RUB: 1, USD: 100 / 9000 }; // 9000 RUB == 100 USD

test('normalizeCurrency: identity conversion needs no rates', () => {
  const txs = [{ type: 'expense', amount: 5000, currency: 'RUB' }];
  const { transactions, ok } = normalizeTransactionsCurrency(txs, 'RUB', null);
  assert.equal(ok, true);
  assert.equal(transactions[0].amount, 5000);
  assert.equal(transactions[0].currency, 'RUB');
  assert.equal(transactions[0].originalAmount, 5000);
  assert.equal(transactions[0].originalCurrency, 'RUB');
});

test('normalizeCurrency: converts RUB tx into USD target', () => {
  const txs = [{ type: 'expense', amount: 9000, currency: 'RUB' }];
  const { transactions, ok } = normalizeTransactionsCurrency(txs, 'USD', RATES);
  assert.equal(ok, true);
  assert.ok(Math.abs(transactions[0].amount - 100) < 0.01, `expected ~100, got ${transactions[0].amount}`);
  assert.equal(transactions[0].currency, 'USD');
  assert.equal(transactions[0].originalAmount, 9000);
  assert.equal(transactions[0].originalCurrency, 'RUB');
});

test('normalizeCurrency: legacy Web transaction (no currency, no source, timestamped inside the USD-bug window) resolves as USD, amount unchanged', () => {
  const txs = [{ type: 'expense', amount: 2000000, createdAt: { toMillis: () => Date.parse('2026-06-01T00:00:00Z') } }];
  const { transactions, ok } = normalizeTransactionsCurrency(txs, 'USD', RATES);
  assert.equal(ok, true);
  assert.equal(transactions[0].amount, 2000000, 'must NOT multiply/rescale the raw amount');
  assert.equal(transactions[0].currency, 'USD');
  assert.equal(transactions[0].originalCurrency, 'USD');
});

test('normalizeCurrency: legacy Telegram transaction (no currency, source=telegram-bot) resolves as RUB', () => {
  const txs = [{ type: 'expense', amount: 5000, source: 'telegram-bot' }];
  const { transactions, ok } = normalizeTransactionsCurrency(txs, 'RUB', null);
  assert.equal(ok, true);
  assert.equal(transactions[0].amount, 5000);
  assert.equal(transactions[0].originalCurrency, 'RUB');
});

test('normalizeCurrency: transaction with no currency, no source, no timestamp at all → UNKNOWN → ok=false (never guessed as RUB)', () => {
  const txs = [{ type: 'expense', amount: 9000 }]; // nothing to resolve from
  const result = normalizeTransactionsCurrency(txs, 'USD', RATES);
  assert.equal(result.ok, false, 'must refuse to compute rather than silently assume RUB');
  assert.equal(result.transactions, null);
});

test('normalizeCurrency: legacy Web transaction outside the provable USD window (currency + createdAt both missing, dated after the RUB base-flip) → UNKNOWN', () => {
  const txs = [{ type: 'expense', amount: 5000, createdAt: { toMillis: () => Date.parse('2026-09-18T09:30:00Z') } }];
  const result = normalizeTransactionsCurrency(txs, 'RUB', null);
  assert.equal(result.ok, false, 'the ~71min post-fix gap is genuinely unprovable, must not default to RUB or USD');
});

test('normalizeCurrency: mixed currencies convert-then-produce per-tx amounts in target currency', () => {
  const txs = [
    { type: 'expense', amount: 9000, currency: 'RUB' },
    { type: 'expense', amount: 100,  currency: 'USD' },
  ];
  const { transactions, ok } = normalizeTransactionsCurrency(txs, 'USD', RATES);
  assert.equal(ok, true);
  const total = transactions.reduce((s, t) => s + t.amount, 0);
  assert.ok(Math.abs(total - 200) < 0.01, `expected ~200, got ${total}`);
});

test('normalizeCurrency: FX required but unavailable → ok=false, never fabricates equality', () => {
  const txs = [
    { type: 'expense', amount: 9000, currency: 'RUB' },
    { type: 'expense', amount: 100,  currency: 'USD' },
  ];
  const result = normalizeTransactionsCurrency(txs, 'USD', null);
  assert.equal(result.ok, false);
  assert.equal(result.transactions, null);
});

test('normalizeCurrency: never mutates the input array/objects', () => {
  const original = { type: 'expense', amount: 9000, currency: 'RUB' };
  const txs = [original];
  normalizeTransactionsCurrency(txs, 'USD', RATES);
  assert.equal(original.amount, 9000);
  assert.equal(original.currency, 'RUB');
  assert.equal(txs.length, 1);
});

test('needsFx: false when all transactions already match target currency', () => {
  const txs = [{ amount: 100, currency: 'USD' }, { amount: 200, currency: 'USD' }];
  assert.equal(needsFx(txs, 'USD'), false);
});

test('needsFx: false for an all-explicit RUB dataset against RUB target', () => {
  const txs = [{ amount: 100, currency: 'RUB' }, { amount: 200, currency: 'RUB' }];
  assert.equal(needsFx(txs, 'RUB'), false);
});

test('needsFx: true for a legacy Telegram transaction (no currency field) — resolver must run, not skip', () => {
  const txs = [{ amount: 100, source: 'telegram-bot' }]; // resolves to RUB, but needsFx must actually resolve it, not assume
  assert.equal(needsFx(txs, 'RUB'), false); // resolves to RUB == target, so no FX needed
  assert.equal(needsFx(txs, 'USD'), true);  // resolves to RUB != USD target, FX needed
});

test('needsFx: true when currency cannot be resolved at all (forces the safe ok=false path downstream)', () => {
  const txs = [{ amount: 100 }]; // no currency, no source, no timestamp
  assert.equal(needsFx(txs, 'RUB'), true);
});

test('needsFx: true when at least one transaction differs', () => {
  const txs = [{ amount: 100, currency: 'USD' }, { amount: 200, currency: 'RUB' }];
  assert.equal(needsFx(txs, 'USD'), true);
});

// ── Goals ─────────────────────────────────────────────────────────────────────

test('normalizeGoalsCurrency: goal stays unchanged when its currency already matches target', () => {
  const goals = [{ id: 'g1', targetAmount: 500000, currentAmount: 100000, currency: 'RUB' }];
  const { goals: out, ok } = normalizeGoalsCurrency(goals, 'RUB', null);
  assert.equal(ok, true);
  assert.equal(out[0].targetAmount, 500000);
  assert.equal(out[0].currentAmount, 100000);
  assert.equal(out[0].originalTargetAmount, 500000);
  assert.equal(out[0].originalCurrency, 'RUB');
});

test('normalizeGoalsCurrency: converts a RUB goal into the USD calculation currency, never mutating the source', () => {
  const original = { id: 'g1', targetAmount: 9000000, currentAmount: 900000, currency: 'RUB' };
  const { goals: out, ok } = normalizeGoalsCurrency([original], 'USD', RATES);
  assert.equal(ok, true);
  assert.ok(Math.abs(out[0].targetAmount - 100000) < 1, `expected ~100000 USD, got ${out[0].targetAmount}`);
  assert.ok(Math.abs(out[0].currentAmount - 10000) < 1, `expected ~10000 USD, got ${out[0].currentAmount}`);
  assert.equal(original.targetAmount, 9000000, 'source goal object must be untouched');
  assert.equal(original.currency, 'RUB');
});

test('normalizeGoalsCurrency: missing currency field defaults to RUB (goals always write it — a true field-absent fallback)', () => {
  const goals = [{ id: 'g1', targetAmount: 500000, currentAmount: 0 }]; // no currency field
  const { goals: out, ok } = normalizeGoalsCurrency(goals, 'RUB', null);
  assert.equal(ok, true);
  assert.equal(out[0].originalCurrency, 'RUB');
});

test('goalsNeedFx: false when goal currency already matches target', () => {
  assert.equal(goalsNeedFx([{ targetAmount: 1, currentAmount: 0, currency: 'USD' }], 'USD'), false);
});

test('goalsNeedFx: true when goal currency differs from target', () => {
  assert.equal(goalsNeedFx([{ targetAmount: 1, currentAmount: 0, currency: 'RUB' }], 'USD'), true);
});
