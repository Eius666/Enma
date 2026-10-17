'use strict';

// Against the REAL Firestore emulator: transactional atomicity of
// POST /api/payment/trial under concurrency (the in-memory mock cannot show it).
//   npm run test:trial-integration
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const realAdmin = require('firebase-admin');
if (!realAdmin.apps.length) realAdmin.initializeApp({ projectId: 'enma-rules-test' });
const db = realAdmin.firestore();

// Hand the handler the emulator db; auth is not under test here (no Authorization header; auth is not under test here).
const fa = require.resolve('../../_lib/firebaseAdmin');
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: { firestore: realAdmin.firestore, auth: () => ({}) } } };
const handler = require('../[action]');

const FAR = 4102444800000;
async function wipe() {
  await Promise.all([db.recursiveDelete(db.collection('users')), db.recursiveDelete(db.collection('subscriptions'))]);
}
beforeEach(wipe);

async function trial(userId) {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() {} };
  await handler({ method: 'POST', query: { action: 'trial' }, body: { userId }, headers: {} }, res);
  return res;
}
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

test('20 concurrent trial requests for a new user create exactly one trial', async () => {
  await db.collection('users').doc('u1').set({ currency: 'RUB' });
  const results = await quiet(() => Promise.all(Array.from({ length: 20 }, () => trial('u1'))));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 1, JSON.stringify(codes));
  assert.equal(codes.filter((c) => c === 409).length, 19, JSON.stringify(codes));
  const snap = await db.collection('subscriptions').get();
  assert.equal(snap.size, 1);
  assert.equal(snap.docs[0].data().trialPlan, 'premium');
  assert.equal((await db.collection('users').doc('u1').get()).data().trialUsed, true);
});

test('a paid subscription survives concurrent trial requests byte-for-byte', async () => {
  const sub = { userId: 'u1', plan: 'premium', period: 'year', status: 'active', endDate: '2100-01-01T00:00:00.000Z', endDateMs: FAR, paymentMethod: 'sbp' };
  await db.collection('subscriptions').doc('u1').set(sub);
  await db.collection('users').doc('u1').set({ trialUsed: 7 }); // type drift: counter instead of boolean
  const results = await quiet(() => Promise.all(Array.from({ length: 10 }, () => trial('u1'))));
  assert.ok(results.every((r) => r.statusCode === 409 && r.body.code === 'SUBSCRIPTION_EXISTS'));
  assert.deepEqual((await db.collection('subscriptions').doc('u1').get()).data(), sub);
  assert.equal((await db.collection('users').doc('u1').get()).data().trialUsed, 7);
});

test('expired paid subscription is not replaced by a trial', async () => {
  const sub = { userId: 'u1', plan: 'pro', status: 'active', endDate: '2020-01-01T00:00:00.000Z', endDateMs: 1577836800000, lastPaymentMethod: 'sbp' };
  await db.collection('subscriptions').doc('u1').set(sub);
  const res = await quiet(() => trial('u1'));
  assert.equal(res.statusCode, 409);
  assert.deepEqual((await db.collection('subscriptions').doc('u1').get()).data(), sub);
});
