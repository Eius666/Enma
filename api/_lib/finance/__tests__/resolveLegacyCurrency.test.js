'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { resolveTransactionCurrency, WEB_USD_BUG_END } = require('../resolveLegacyCurrency');

test('explicit currency field always wins, regardless of source/date', () => {
  const r = resolveTransactionCurrency({ currency: 'EUR', source: 'telegram-bot', amount: 100 });
  assert.deepEqual(r, { currency: 'EUR', confidence: 'exact', reason: 'explicit_field' });
});

test('SPEC: legacy Web transaction inside the USD-bug window resolves to USD, never RUB', () => {
  const tx = {
    amount: 2000000,
    source: null,
    currency: null,
    createdAt: { toMillis: () => Date.parse('2026-06-15T00:00:00Z') },
  };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, 'USD');
  assert.equal(r.confidence, 'exact');
  assert.notEqual(r.currency, 'RUB');
});

test('legacy Web transaction from before BASE_CURRENCY=USD even existed also resolves to USD (hardcoded formatter era)', () => {
  const tx = { amount: 500, createdAt: { toMillis: () => Date.parse('2025-10-01T00:00:00Z') } };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, 'USD');
  assert.equal(r.confidence, 'exact');
});

test('legacy Web transaction right at the RUB base-flip boundary is the last USD-resolvable moment', () => {
  const justBefore = { amount: 1, createdAt: { toMillis: () => WEB_USD_BUG_END - 1 } };
  assert.equal(resolveTransactionCurrency(justBefore).currency, 'USD');

  const atOrAfter = { amount: 1, createdAt: { toMillis: () => WEB_USD_BUG_END } };
  assert.notEqual(resolveTransactionCurrency(atOrAfter).currency, 'USD');
});

test('SPEC: legacy transaction with no provable storage semantics resolves to UNKNOWN, not RUB', () => {
  const tx = { amount: 9000 }; // no currency, no source, no createdAt, no date
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, null);
  assert.equal(r.confidence, 'unknown');
});

test('the ~71min post-RUB-flip gap (BASE_CURRENCY=RUB but currency field not yet written) is UNKNOWN', () => {
  const tx = { amount: 5000, createdAt: { toMillis: () => WEB_USD_BUG_END + 60_000 } };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, null);
  assert.equal(r.confidence, 'unknown');
  assert.equal(r.reason, 'legacy_storage_semantics_unknown_post_fix_gap');
});

test('legacy Telegram transaction (source=telegram-bot, no currency) resolves to RUB with high (not exact) confidence', () => {
  const tx = { amount: 5000, source: 'telegram-bot' };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, 'RUB');
  assert.equal(r.confidence, 'high');
  assert.equal(r.reason, 'legacy_telegram_no_conversion_rub_symbol');
});

test('a source=ai-chat record without currency is anomalous (this population never existed without currency) — UNKNOWN', () => {
  const tx = { amount: 100, source: 'ai-chat' };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, null);
  assert.equal(r.confidence, 'unknown');
});

test('unrecognized source value never guessed — UNKNOWN', () => {
  const tx = { amount: 100, source: 'some-future-channel' };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, null);
  assert.equal(r.confidence, 'unknown');
});

test('date string fallback works when createdAt is absent (e.g. old docs without a server timestamp)', () => {
  const tx = { amount: 100, date: '2026-03-01T12:00:00.000Z' };
  const r = resolveTransactionCurrency(tx);
  assert.equal(r.currency, 'USD'); // inside the bug window
  assert.equal(r.confidence, 'exact');
});
