'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { aggregateQuotes, MIN_BANK_SAMPLE } = require('../aggregate');
const { parseQuotes, extractBankList, FxProviderError } = require('../bankiProvider');
const { createFxService, FxUnavailableError } = require('../index');

// ── aggregation ──────────────────────────────────────────────────────────────

test('SPEC: outlier 96 among [84 84.5 85 85.2 85.4 85.7] does not distort the rate', () => {
  const r = aggregateQuotes([84, 84.5, 85, 85.2, 85.4, 85.7, 96]);
  assert.equal(r.ok, true);
  assert.equal(r.discarded, 1);
  assert.equal(r.sampleSize, 6);
  assert.ok(r.rate >= 85 && r.rate <= 85.2, `median of the clean sample, got ${r.rate}`);
});

test('aggregation: fewer than MIN_BANK_SAMPLE quotes → insufficient_sample', () => {
  assert.equal(MIN_BANK_SAMPLE, 5);
  const r = aggregateQuotes([85, 85.1, 85.2, 85.3]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_sample');
});

test('aggregation: garbage values are ignored, not averaged in', () => {
  const r = aggregateQuotes([85, 85.1, 85.2, 85.3, 85.4, NaN, 0, -5, null, 'x']);
  assert.equal(r.ok, true);
  assert.equal(r.sampleSize, 5);
});

// ── Banki adapter (fixture — no network) ─────────────────────────────────────

function fixtureHtml(rows) {
  const json = JSON.stringify({ x: { resultList: { list: rows } } }).replace(/"/g, '&quot;');
  return `<div data-module-options="${json}"></div>`;
}
const NOW = Date.parse('2026-09-18T12:00:00Z');
const row = (buy, sale, refreshDate = '2026-09-18T10:00:00Z') => ({ exchange: { buy, sale, refreshDate }, name: 'Bank [x] ,' });

test('banki: expense side reads `sale` (bank sells), income side reads `buy` (bank buys)', () => {
  const html = fixtureHtml([row(84, 86), row(84.5, 86.4)]);
  assert.deepEqual(parseQuotes(html, 'bank_sells', NOW).quotes, [86, 86.4]);
  assert.deepEqual(parseQuotes(html, 'bank_buys', NOW).quotes, [84, 84.5]);
});

test('banki: inverted (buy > sale) and stale rows are dropped', () => {
  const html = fixtureHtml([row(90, 80), row(84, 86, '2026-08-01T00:00:00Z'), row(84, 86)]);
  assert.equal(parseQuotes(html, 'bank_sells', NOW).quotes.length, 1);
});

test('banki: layout change → FxProviderError, never a bogus number', () => {
  assert.throws(() => extractBankList('<html>nothing here</html>'), FxProviderError);
  assert.throws(() => parseQuotes(fixtureHtml([]), 'bank_sells', NOW), FxProviderError);
});

// ── service chain ────────────────────────────────────────────────────────────

const quotes = (vals) => async ({ side }) => ({ quotes: vals, provider: 'banki', refreshedAt: '2026-09-18T10:00:00Z', side });
const cbr = (rate) => async () => ({ rateToRub: rate, provider: 'cbr', source: 'official_fallback', rateDate: '2026-09-18' });

test('service: bank average → source bank_average, sell side for expense, buy side for income', async () => {
  const seen = [];
  const fx = createFxService({
    fetchBankQuotes: async ({ side }) => { seen.push(side); return { quotes: [85, 85.1, 85.2, 85.3, 85.4, 85.5], provider: 'banki', refreshedAt: '2026-09-18T10:00:00Z' }; },
    fallbackChain: [],
  });
  const e = await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  const i = await fx.getBankRateToRub({ currency: 'USD', transactionType: 'income' });
  assert.deepEqual(seen, ['bank_sells', 'bank_buys']);
  assert.equal(e.source, 'bank_average');
  assert.equal(e.rateSide, 'bank_sells');
  assert.equal(i.rateSide, 'bank_buys');
  assert.equal(e.method, 'median_mad_filtered');
});

test('service: Banki down → CBR fallback labelled official_fallback (not a bank rate)', async () => {
  const fx = createFxService({
    fetchBankQuotes: async () => { throw new FxProviderError('banki', 'network_error', 'x'); },
    fallbackChain: [cbr(90)],
  });
  const r = await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  assert.equal(r.source, 'official_fallback');
  assert.equal(r.provider, 'cbr');
  assert.equal(r.rateSide, 'mid');
  assert.equal(r.rateToRub, 90);
});

test('service: too-small Banki sample falls back instead of trusting 3 banks', async () => {
  const fx = createFxService({ fetchBankQuotes: quotes([85, 85.1, 85.2]), fallbackChain: [cbr(90)] });
  const r = await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  assert.equal(r.source, 'official_fallback');
});

test('SPEC: every provider fails → FxUnavailableError (no invented rate)', async () => {
  const boom = async () => { throw new FxProviderError('x', 'http_error', '500'); };
  const fx = createFxService({ fetchBankQuotes: boom, fallbackChain: [boom, boom] });
  await assert.rejects(() => fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' }), FxUnavailableError);
});

test('service: RUB is never sent to FX', async () => {
  const fx = createFxService({ fetchBankQuotes: quotes([]), fallbackChain: [] });
  await assert.rejects(() => fx.getBankRateToRub({ currency: 'RUB', transactionType: 'expense' }));
});

test('service: cache — second lookup inside TTL does not hit providers; expires after TTL', async () => {
  let calls = 0, t = 1_000_000;
  const fx = createFxService({
    fetchBankQuotes: async () => { calls++; return { quotes: [85, 85.1, 85.2, 85.3, 85.4], provider: 'banki', refreshedAt: null }; },
    fallbackChain: [],
    now: () => t,
  });
  await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  assert.equal(calls, 1);
  t += 11 * 60 * 1000;
  await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense' });
  assert.equal(calls, 2);
});

test('service: back-dated transaction is NOT presented as a historical rate', async () => {
  const fx = createFxService({ fetchBankQuotes: quotes([85, 85.1, 85.2, 85.3, 85.4]), fallbackChain: [], now: () => NOW });
  const r = await fx.getBankRateToRub({ currency: 'USD', transactionType: 'expense', timestamp: '2026-01-05T12:00:00Z' });
  assert.equal(r.requestedDate, '2026-01-05');
  assert.equal(r.rateMatchesRequestedDate, false);
  assert.ok(r.capturedAt && r.rateDate);
});

test('banki: a challenge/captcha page yields layout_changed WITH a content-free diagnostic', async () => {
  const { fetchQuotes } = require('../bankiProvider');
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><title>Проверка браузера</title>captcha</html>' });
  await assert.rejects(
    () => fetchQuotes({ currency: 'USD', side: 'bank_sells', fetchImpl }),
    (e) => e.reason === 'layout_changed' && /markers=captcha/.test(e.detail) && /hasResultList=false/.test(e.detail) && !/<html/.test(e.detail),
  );
});
