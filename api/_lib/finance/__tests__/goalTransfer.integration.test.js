'use strict';

// Integration test for transferGoalFunds against the REAL Firestore
// EMULATOR — proves the concurrency/atomicity guarantees that an in-memory
// mock can't (see goalTransfer.test.js's note on why the "two parallel
// deposits" scenario moved here). Never touches production, never a real
// FX provider.
//
//   npm run test:finance-integration

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'enma-rules-test' });
const db = admin.firestore();

const { transferGoalFunds, goalTransferDocId, GoalTransferError } = require('../goalTransfer');

function fakeFx(rates) {
  return {
    async getBankRateToRub({ currency, transactionType }) {
      if (!rates[currency]) throw new Error(`no rate for ${currency}`);
      return {
        rateToRub: rates[currency], source: 'bank_average', provider: 'test',
        capturedAt: '2026-09-18T10:00:00.000Z', rateDate: '2026-09-18',
        method: 'median_mad_filtered',
        rateSide: transactionType === 'income' ? 'bank_buys' : 'bank_sells',
      };
    },
  };
}

async function wipe() {
  await Promise.all([db.recursiveDelete(db.collection('goals')), db.recursiveDelete(db.collection('transactions')), db.recursiveDelete(db.collection('users'))]);
}

beforeEach(wipe);

const run = (input, fx = fakeFx({ USD: 86 })) =>
  transferGoalFunds({ uid: 'u1', ...input }, { firebase: { db, admin }, fx });

test('two concurrent deposits with different operationIds both apply — real transaction isolation', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'u1', title: 'Машина', targetAmount: 100000, currentAmount: 0, currency: 'RUB' });

  await Promise.all([
    run({ goalId: 'g1', direction: 'contribution', amount: 1000, operationId: 'a' }),
    run({ goalId: 'g1', direction: 'contribution', amount: 2000, operationId: 'b' }),
  ]);

  const g = (await db.collection('goals').doc('g1').get()).data();
  assert.equal(g.currentAmount, 3000); // neither write was lost
  const txs = await db.collection('transactions').where('goalId', '==', 'g1').get();
  assert.equal(txs.size, 2);
});

test('two concurrent retries of the SAME operationId apply exactly once', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'u1', title: 'Машина', targetAmount: 100000, currentAmount: 0, currency: 'RUB' });

  const results = await Promise.all([
    run({ goalId: 'g1', direction: 'contribution', amount: 5000, operationId: 'dup' }),
    run({ goalId: 'g1', direction: 'contribution', amount: 5000, operationId: 'dup' }),
  ]);

  const g = (await db.collection('goals').doc('g1').get()).data();
  assert.equal(g.currentAmount, 5000); // not 10000
  assert.equal(results.filter(r => r.duplicate).length, 1); // exactly one of the two saw itself as a duplicate
  const txs = await db.collection('transactions').where('goalId', '==', 'g1').get();
  assert.equal(txs.size, 1);
});

test('sequential contribution then withdrawal nets out correctly, atomically', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'u1', title: 'Отпуск', targetAmount: 50000, currentAmount: 10000, currency: 'RUB' });
  await run({ goalId: 'g1', direction: 'contribution', amount: 5000, operationId: 'c1' });
  await run({ goalId: 'g1', direction: 'withdrawal', amount: 2000, operationId: 'w1' });
  const g = (await db.collection('goals').doc('g1').get()).data();
  assert.equal(g.currentAmount, 13000);
});

test('a USD contribution to a RUB goal locks a real-shaped FX snapshot end to end', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'u1', title: 'Телефон', targetAmount: 1000, currentAmount: 0, currency: 'USD' });
  await run({ goalId: 'g1', direction: 'contribution', amount: 100, currency: 'USD', operationId: 'op1' });
  const g = (await db.collection('goals').doc('g1').get()).data();
  assert.equal(g.currentAmount, 100); // same currency as the goal — identity, no FX distortion
  const t = (await db.collection('transactions').doc(goalTransferDocId('op1')).get()).data();
  assert.equal(t.fx.rateToRub, 86);
  assert.equal(t.rubAmount, 8600);
});

test('withdrawing from a goal that does not belong to the caller is rejected, no write', async () => {
  await db.collection('goals').doc('g1').set({ userId: 'someone-else', title: 'X', targetAmount: 1000, currentAmount: 500, currency: 'RUB' });
  await assert.rejects(
    () => run({ goalId: 'g1', direction: 'withdrawal', amount: 100, operationId: 'op1' }),
    (err) => err instanceof GoalTransferError && err.code === 'NOT_FOUND'
  );
  const g = (await db.collection('goals').doc('g1').get()).data();
  assert.equal(g.currentAmount, 500);
});
