'use strict';

// Integration test for exportFinancePdf against the REAL Firestore
// EMULATOR — this orchestrator is the only layer that actually touches
// Firestore (repositories/transactions.js, repositories/goals.js,
// firebaseAdmin's db), so a mock can't meaningfully exercise it.
//
//   npm run test:pdf-integration

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'enma-rules-test' });
const db = admin.firestore();

// exportFinancePdf.js requires '../firebaseAdmin' (the REAL module) at
// load time, which throws without FIREBASE_SERVICE_ACCOUNT — inject a
// fake module exports pointing at the SAME emulator-backed admin/db
// before requiring it, exactly like the admin-action test fixtures do.
const fa = require.resolve('../../firebaseAdmin');
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin } };

const { exportFinancePdf } = require('../exportFinancePdf');
const { PDFParse } = require('pdf-parse');

async function wipe() {
  await Promise.all([
    db.recursiveDelete(db.collection('transactions')),
    db.recursiveDelete(db.collection('goals')),
  ]);
}
before(wipe);
beforeEach(wipe);
after(async () => { await wipe(); });

async function extractText(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

async function seedTx(doc) {
  await db.collection('transactions').doc().set(doc);
}

test('exports a real PDF from seeded Firestore data, reconciling against what was written', async () => {
  await seedTx({ userId: 'u1', type: 'income', amount: 50000, currency: 'RUB', rubAmount: 50000, schemaVersion: 2, fx: null, category: 'cat-salary', description: 'Зарплата', date: '2026-09-01T09:00:00.000Z', source: 'web-app' });
  await seedTx({ userId: 'u1', type: 'expense', amount: 1200, currency: 'RUB', rubAmount: 1200, schemaVersion: 2, fx: null, category: 'cat-food', description: 'Продукты', date: '2026-09-05T09:00:00.000Z', source: 'web-app' });

  const result = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(result.ok, true);
  assert.equal(result.transactionCount, 2);
  assert.equal(result.buffer.slice(0, 4).toString('latin1'), '%PDF');

  const text = await extractText(result.buffer);
  assert.match(text, /50 000,00 ₽/);
  assert.match(text, /1 200,00 ₽/);
  assert.match(text, /Зарплата/);
});

test('ownership isolation: another user\'s transactions never appear, even though they exist in the same collection', async () => {
  await seedTx({ userId: 'u1', type: 'income', amount: 1000, currency: 'RUB', rubAmount: 1000, schemaVersion: 2, fx: null, category: 'cat-x', description: 'mine', date: '2026-09-01T09:00:00.000Z', source: 'web-app' });
  await seedTx({ userId: 'u2', type: 'income', amount: 999999, currency: 'RUB', rubAmount: 999999, schemaVersion: 2, fx: null, category: 'cat-x', description: 'SECRET_OTHER_USER_DATA', date: '2026-09-01T09:00:00.000Z', source: 'web-app' });

  const result = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(result.ok, true);
  assert.equal(result.transactionCount, 1);
  const text = await extractText(result.buffer);
  assert.ok(!text.includes('SECRET_OTHER_USER_DATA'));
  assert.ok(!text.includes('999999'));
});

test('full retrieval: hundreds of transactions all make it into the report, none lost at a page/query boundary', async () => {
  const batch = db.batch();
  for (let i = 0; i < 400; i++) {
    batch.set(db.collection('transactions').doc(`t${i}`), {
      // Short, fixed-length marker (not a long free-text description) —
      // deliberately chosen so this test verifies row COMPLETENESS
      // without the column-width truncation that a long description
      // would legitimately (and correctly) trigger; that truncation
      // behavior itself is covered separately in financeReportPdf.test.js.
      userId: 'u1', type: 'expense', amount: 10 + i, currency: 'RUB', rubAmount: 10 + i,
      schemaVersion: 2, fx: null, category: 'cat-misc', description: `Tx${String(i).padStart(3, '0')}`,
      date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`, source: 'web-app',
    });
  }
  await batch.commit();

  const result = await exportFinancePdf({ uid: 'u1', period: 'all', includeCharts: false });
  assert.equal(result.ok, true);
  assert.equal(result.transactionCount, 400);
  const text = await extractText(result.buffer);
  assert.match(text, /Tx000(?!\d)/);
  assert.match(text, /Tx399(?!\d)/);
  assert.match(text, /Количество операций: 400/);
});

test('period filtering: month excludes transactions outside it, while "all" includes everything', async () => {
  await seedTx({ userId: 'u1', type: 'expense', amount: 100, currency: 'RUB', rubAmount: 100, schemaVersion: 2, fx: null, category: 'cat-x', description: 'InSeptember', date: '2026-09-15T09:00:00.000Z', source: 'web-app' });
  await seedTx({ userId: 'u1', type: 'expense', amount: 200, currency: 'RUB', rubAmount: 200, schemaVersion: 2, fx: null, category: 'cat-x', description: 'InJanuary', date: '2026-01-15T09:00:00.000Z', source: 'web-app' });

  const custom = await exportFinancePdf({ uid: 'u1', period: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.equal(custom.transactionCount, 1);
  const customText = await extractText(custom.buffer);
  assert.ok(customText.includes('InSeptember'));
  assert.ok(!customText.includes('InJanuary'));

  const all = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(all.transactionCount, 2);
});

test('goal_deposit/goal_withdraw correctly feed the goal\'s savings balance, not income/expense', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'u1', title: 'Car', targetAmount: 100000, currentAmount: 20000, currency: 'RUB', currentAmountRub: 20000 });
  await seedTx({ userId: 'u1', type: 'goal_deposit', amount: 20000, currency: 'RUB', rubAmount: 20000, schemaVersion: 2, fx: null, budgetImpact: false, goalId: 'g1', description: 'Накопления: Car', date: '2026-09-01T09:00:00.000Z', source: 'web-app' });

  const result = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(result.ok, true);
  const text = await extractText(result.buffer);
  assert.match(text, /Car/);
  assert.match(text, /20 000,00 ₽/);
  assert.match(text, /Пополнение цели/);
  // The deposit must not be double-counted as "income" in the summary.
  assert.match(text, /Доходы за период[\s\S]{0,5}0,00 ₽/);
});

test('legacy (pre-schemaVersion-2) transactions are included and valued correctly', async () => {
  // telegram-bot legacy records: no currency field, resolved as RUB per
  // resolveLegacyCurrency.js's proven historical rule.
  await seedTx({ userId: 'u1', type: 'expense', amount: 500, description: 'Старая запись', date: '2026-05-01T09:00:00.000Z', source: 'telegram-bot' });

  const result = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(result.ok, true);
  const text = await extractText(result.buffer);
  assert.match(text, /Старая запись/);
  assert.match(text, /500,00 ₽/);
});

test('empty history: a user with zero transactions still gets a valid PDF, not an error', async () => {
  const result = await exportFinancePdf({ uid: 'brand-new-user', period: 'all' });
  assert.equal(result.ok, true);
  assert.equal(result.transactionCount, 0);
  assert.equal(result.buffer.slice(0, 4).toString('latin1'), '%PDF');
});

test('an unknown period is rejected with a specific error code, not a silently-wrong report', async () => {
  const result = await exportFinancePdf({ uid: 'u1', period: 'decade' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_PERIOD');
});

test('an invalid custom date range (dateFrom after dateTo) is rejected', async () => {
  const result = await exportFinancePdf({ uid: 'u1', period: 'custom', dateFrom: '2026-09-30', dateTo: '2026-09-01' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_DATE_RANGE');
});

test('missing uid is rejected rather than silently exporting nothing/everything', async () => {
  const result = await exportFinancePdf({ period: 'all' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNAUTHENTICATED');
});

test('repeating the same export twice produces two independent, equally valid PDFs (idempotent request handling)', async () => {
  await seedTx({ userId: 'u1', type: 'income', amount: 100, currency: 'RUB', rubAmount: 100, schemaVersion: 2, fx: null, category: 'cat-x', description: 'x', date: '2026-09-01T09:00:00.000Z', source: 'web-app' });
  const first = await exportFinancePdf({ uid: 'u1', period: 'all' });
  const second = await exportFinancePdf({ uid: 'u1', period: 'all' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.transactionCount, second.transactionCount);
});
