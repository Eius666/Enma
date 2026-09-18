'use strict';

// Unified creation service: currency precedence, locked rubAmount, FX
// snapshot, history immutability, edit semantics, trust boundary, idempotency.
// Fully offline: fake FX + in-memory Firestore double.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');
const {
  createFinancialTransaction, buildTransactionUpdate, resolveOperationCurrency,
} = require('../financialTransaction');
const { FxUnavailableError } = require('../../fx');

function fakeFx(rates, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    setRate(c, r) { rates[c] = r; },
    async getBankRateToRub({ currency, transactionType, timestamp }) {
      calls.push({ currency, transactionType });
      if (fail || !rates[currency]) throw new FxUnavailableError(currency, []);
      return {
        rateToRub: rates[currency], source: 'bank_average', provider: 'banki',
        capturedAt: '2026-09-18T10:00:00.000Z', rateDate: '2026-09-18', sampleSize: 7,
        method: 'median_mad_filtered', rateSide: transactionType === 'income' ? 'bank_buys' : 'bank_sells',
      };
    },
  };
}

function setup(userCurrency, rates = { USD: 86, EUR: 101, CNY: 12 }, opts) {
  const db = createMockDb({ 'users/u1': { currency: userCurrency } });
  const fx = fakeFx(rates, opts);
  const create = (input, extra = {}) => createFinancialTransaction(
    { uid: 'u1', type: 'expense', description: 'x', ...input },
    { firebase: { db, admin: mockAdmin }, fx, ...extra },
  );
  const all = async () => (await db.collection('transactions').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  return { db, fx, create, all };
}

// ── 1. RUB baseline ──────────────────────────────────────────────────────────
test('1. RUB user, "ресторан 5000" → 5000 RUB, rubAmount 5000, fx null, no FX call', async () => {
  const { create, fx, all } = setup('RUB');
  const r = await create({ amount: 5000, description: 'Ресторан' });
  assert.equal(r.ok, true);
  const [tx] = await all();
  assert.equal(tx.schemaVersion, 2);
  assert.equal(tx.currency, 'RUB'); assert.equal(tx.amount, 5000); assert.equal(tx.rubAmount, 5000); assert.equal(tx.fx, null);
  assert.equal(fx.calls.length, 0);
});

// ── 2. switch to USD ─────────────────────────────────────────────────────────
test('2. user.currency=USD, bare 100 → USD, rubAmount 8600, fx snapshot with source/side', async () => {
  const { create, all } = setup('USD');
  await create({ amount: 100 });
  const [tx] = await all();
  assert.equal(tx.currency, 'USD'); assert.equal(tx.rubAmount, 8600);
  assert.equal(tx.fx.rateToRub, 86); assert.equal(tx.fx.source, 'bank_average'); assert.equal(tx.fx.rateSide, 'bank_sells');
  assert.ok(tx.fx.capturedAt && tx.fx.rateDate && tx.fx.provider && tx.fx.method);
});

// ── 4. explicit RUB while USD ────────────────────────────────────────────────
test('4. explicit RUB while user.currency=USD → RUB, no FX', async () => {
  const { create, fx, all } = setup('USD');
  await create({ amount: 1000, currency: 'RUB' });
  const [tx] = await all();
  assert.equal(tx.currency, 'RUB'); assert.equal(tx.rubAmount, 1000); assert.equal(fx.calls.length, 0);
});

// ── 5/6. EUR while USD, CNY ──────────────────────────────────────────────────
test('5/6. explicit EUR while USD → EUR snapshot; CNY works', async () => {
  const { create, all } = setup('USD');
  await create({ amount: 100, currency: 'EUR' });
  await create({ amount: 80, currency: 'CNY' });
  const txs = await all();
  assert.equal(txs.find(t => t.currency === 'EUR').rubAmount, 10100);
  assert.equal(txs.find(t => t.currency === 'CNY').rubAmount, 960);
});

// ── income uses the bank-BUYS side ───────────────────────────────────────────
test('income asks FX for the bank-buys side, expense for bank-sells', async () => {
  const { create, fx } = setup('USD');
  await create({ amount: 10, type: 'income' });
  await create({ amount: 10, type: 'expense' });
  assert.deepEqual(fx.calls.map(c => c.transactionType), ['income', 'expense']);
});

// ── 7. return to RUB ─────────────────────────────────────────────────────────
// ── 8. history immutability across RUB→USD→CNY→RUB ───────────────────────────
test('7/8. RUB→USD→CNY→RUB: each op uses the input currency of its time; earlier docs never rewritten', async () => {
  const { db, create, all } = setup('RUB');
  await create({ amount: 5000 }, {});
  const first = JSON.stringify((await all())[0]);

  // count writes to EXISTING docs from here on
  const coll = db.collection('transactions');
  let historicalWrites = 0;
  const ids = new Set((await all()).map(t => t.id));
  const origDoc = coll.doc.bind(coll);
  coll.doc = (id) => {
    const ref = origDoc(id);
    if (ids.has(ref.id)) {
      for (const m of ['set', 'update', 'delete']) {
        const orig = ref[m] && ref[m].bind(ref);
        if (orig) ref[m] = (...a) => { historicalWrites++; return orig(...a); };
      }
    }
    return ref;
  };

  for (const cur of ['USD', 'CNY', 'RUB']) {
    await db.collection('users').doc('u1').set({ currency: cur }, { merge: true });
    await create({ amount: 10, description: `tx ${cur}`, userCurrency: undefined });
    for (const t of await all()) ids.add(t.id);
  }
  const txs = await all();
  assert.equal(txs.length, 4);
  assert.equal(JSON.stringify(txs.find(t => t.description === 'x' && t.amount === 5000)), first);
  assert.equal(historicalWrites, 0);
  assert.deepEqual(['USD', 'CNY', 'RUB'].map(c => txs.find(t => t.description === `tx ${c}`).currency), ['USD', 'CNY', 'RUB']);
});

// ── 9. rate change never touches stored rubAmount ────────────────────────────
test('9. rate changes after creation: stored rubAmount stays 8600; a NEW tx gets the new rate', async () => {
  const { create, fx, all } = setup('USD');
  await create({ amount: 100, description: 'old' });
  fx.setRate('USD', 95);
  await create({ amount: 100, description: 'new' });
  const txs = await all();
  assert.equal(txs.find(t => t.description === 'old').rubAmount, 8600);
  assert.equal(txs.find(t => t.description === 'new').rubAmount, 9500);
});

// ── 10. mixed budget ─────────────────────────────────────────────────────────
test('10. mixed budget: 5000 RUB + $100 + €100 + ¥500 = 29 700 ₽ from locked rubAmount', async () => {
  const { create, all } = setup('RUB', { USD: 86, EUR: 101, CNY: 12 });
  await create({ amount: 5000 });
  await create({ amount: 100, currency: 'USD' });
  await create({ amount: 100, currency: 'EUR' });
  await create({ amount: 500, currency: 'CNY' });
  const total = (await all()).reduce((s, t) => s + t.rubAmount, 0);
  assert.equal(total, 29700);
});

// ── 11. provider failure ─────────────────────────────────────────────────────
test('11. all FX providers fail → foreign tx NOT written; RUB still works', async () => {
  const { create, all } = setup('USD', {}, { fail: true });
  await assert.rejects(() => create({ amount: 50 }), FxUnavailableError);
  assert.equal((await all()).length, 0);
  const r = await create({ amount: 50, currency: 'RUB' });
  assert.equal(r.ok, true);
  assert.equal((await all()).length, 1);
});

// ── trust boundary ───────────────────────────────────────────────────────────
test('SECURITY: client-sent rubAmount / fx / schemaVersion are ignored', async () => {
  const { create, all } = setup('USD');
  await create({ amount: 100, rubAmount: 1, fx: { rateToRub: 0.01 }, schemaVersion: 99, fxRate: 0.01 });
  const [tx] = await all();
  assert.equal(tx.rubAmount, 8600); assert.equal(tx.fx.rateToRub, 86); assert.equal(tx.schemaVersion, 2);
  assert.equal(tx.fxRate, undefined);
});

test('validation: bad amount / type rejected before any FX call or write', async () => {
  const { create, fx, all } = setup('USD');
  await assert.rejects(() => create({ amount: -5 }));
  await assert.rejects(() => create({ amount: 'abc' }));
  await assert.rejects(() => create({ amount: 5, type: 'transfer' }));
  assert.equal(fx.calls.length, 0);
  assert.equal((await all()).length, 0);
});

// ── idempotency ──────────────────────────────────────────────────────────────
test('idempotency: same docId → one doc, first snapshot canonical, no second FX call', async () => {
  const { create, fx, all } = setup('USD');
  const a = await create({ amount: 100, docId: 'fixed-1' });
  fx.setRate('USD', 99);
  const b = await create({ amount: 100, docId: 'fixed-1' });
  assert.equal(b.duplicate, true);
  assert.equal(a.id, b.id);
  const txs = await all();
  assert.equal(txs.length, 1);
  assert.equal(txs[0].rubAmount, 8600);
  assert.equal(fx.calls.length, 1);
});

test('precedence helper: explicit → user.currency → RUB; garbage falls through', () => {
  assert.equal(resolveOperationCurrency({ explicit: 'EUR', userCurrency: 'USD' }), 'EUR');
  assert.equal(resolveOperationCurrency({ userCurrency: 'CNY' }), 'CNY');
  assert.equal(resolveOperationCurrency({ explicit: 'XXX', userCurrency: 'ZZZ' }), 'RUB');
  assert.equal(resolveOperationCurrency({}), 'RUB');
});

// ── edit semantics ───────────────────────────────────────────────────────────
const v2usd = { schemaVersion: 2, type: 'expense', amount: 100, currency: 'USD', rubAmount: 8600, fx: { rateToRub: 86 }, date: '2026-09-01T12:00:00.000Z' };

test('edit: metadata-only keeps money fields (no FX call)', async () => {
  const fx = fakeFx({ USD: 99 });
  const u = await buildTransactionUpdate({ existing: v2usd, patch: { description: 'new', amount: 100 }, userCurrency: 'USD' }, { fx });
  assert.deepEqual(u, { description: 'new' });
  assert.equal(fx.calls.length, 0);
});

test('edit: amount change → rubAmount = new amount × ORIGINAL rate (not today\'s)', async () => {
  const fx = fakeFx({ USD: 99 });
  const u = await buildTransactionUpdate({ existing: v2usd, patch: { amount: 150 }, userCurrency: 'USD' }, { fx });
  assert.equal(u.amount, 150); assert.equal(u.rubAmount, 12900);
  assert.equal(fx.calls.length, 0);
});

test('edit: currency change → new FX snapshot', async () => {
  const fx = fakeFx({ EUR: 101 });
  const u = await buildTransactionUpdate({ existing: v2usd, patch: { currency: 'EUR' }, userCurrency: 'USD' }, { fx });
  assert.equal(u.currency, 'EUR'); assert.equal(u.rubAmount, 10100); assert.equal(u.fx.rateToRub, 101); assert.equal(u.schemaVersion, 2);
});

test('edit: currency change to RUB → identity, fx null', async () => {
  const fx = fakeFx({});
  const u = await buildTransactionUpdate({ existing: v2usd, patch: { currency: 'RUB' }, userCurrency: 'USD' }, { fx });
  assert.equal(u.currency, 'RUB'); assert.equal(u.rubAmount, 100); assert.equal(u.fx, null);
});

test('edit: legacy tx metadata-only edit stays legacy (no rubAmount invented)', async () => {
  const legacy = { type: 'expense', amount: 5000, currency: 'RUB', date: '2026-01-01' };
  const u = await buildTransactionUpdate({ existing: legacy, patch: { description: 'x', amount: 5000 }, userCurrency: 'USD' }, { fx: fakeFx({}) });
  assert.equal(u.rubAmount, undefined);
  assert.equal(u.schemaVersion, undefined);
});
