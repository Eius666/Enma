'use strict';

// POST /api/payment/trial must never overwrite an existing subscription.
// In-memory Firestore mock — it is NOT a faithful model of concurrent
// transactions (writes are applied after the callback, with no read locking),
// so atomicity under contention is covered by trial.integration.test.js on the
// real emulator (npm run test:trial-integration), not here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = [
  '../[action]', '../../_lib/auth/paymentAuth', '../../_lib/referral/influencer', '../../_lib/referral/partners',
  '../../_lib/referral/codes', '../../_lib/promoCodes', '../../_lib/platega', '../../_lib/subscription/extend',
  '../../_lib/stars/config', '../../_lib/stars/sessions',
];
const JWT = 'aaaa.bbbb.cccc';
const FAR = 4102444800000; // 2100-01-01

function setup(seed, verifyIdToken = async () => ({ uid: 'u1' })) {
  const db = createMockDb(seed);
  const admin = { ...mockAdmin, auth: () => ({ verifyIdToken: async (t) => verifyIdToken(t) }) };
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin } };
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() {} };
}
async function trial(body, authorization = `Bearer ${JWT}`) {
  const orig = console.log; const origErr = console.error; console.log = () => {}; console.error = () => {};
  try {
    const res = mockRes();
    await require('../[action]')({ method: 'POST', query: { action: 'trial' }, body, headers: authorization ? { authorization } : {} }, res);
    return res;
  } finally { console.log = orig; console.error = origErr; }
}
const snapshotOf = (db) => JSON.stringify([...db._store.entries()].sort());

for (const [label, sub] of [
  ['active Premium', { userId: 'u1', plan: 'premium', period: 'year', status: 'active', endDate: '2100-01-01T00:00:00.000Z', endDateMs: FAR, paymentMethod: 'sbp' }],
  ['active Pro', { userId: 'u1', plan: 'pro', period: 'month', status: 'active', endDate: '2100-01-01T00:00:00.000Z', endDateMs: FAR, lastPaymentMethod: 'stars' }],
  ['EXPIRED paid subscription', { userId: 'u1', plan: 'pro', period: 'month', status: 'active', endDate: '2020-01-01T00:00:00.000Z', endDateMs: 1577836800000, lastPaymentMethod: 'sbp' }],
]) {
  test(`${label} is not modified by a trial request (409 SUBSCRIPTION_EXISTS), even when users.trialUsed is missing`, async () => {
    const db = setup({ 'users/u1': { currency: 'RUB' }, 'subscriptions/u1': sub });
    try {
      const before = snapshotOf(db);
      const res = await trial({ userId: 'u1' });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'SUBSCRIPTION_EXISTS');
      assert.equal(snapshotOf(db), before, 'no document may change');
      assert.deepEqual(db._get('subscriptions/u1'), sub);
    } finally { teardown(); }
  });
}

test('paid subscription is protected even when trialUsed was turned into a number (boolean->counter type drift)', async () => {
  const sub = { userId: 'u1', plan: 'premium', status: 'active', endDateMs: FAR, paymentMethod: 'sbp' };
  const db = setup({ 'users/u1': { trialUsed: 1 }, 'subscriptions/u1': sub });
  try {
    const res = await trial({ userId: 'u1' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(db._get('subscriptions/u1'), sub);
  } finally { teardown(); }
});

test('already used trial (trialUsed === true) is rejected with TRIAL_USED and nothing is written', async () => {
  const db = setup({ 'users/u1': { trialUsed: true } });
  try {
    const res = await trial({ userId: 'u1' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'TRIAL_USED');
    assert.equal(db._keys('subscriptions/').length, 0);
  } finally { teardown(); }
});

test('an existing trial subscription document is reported as TRIAL_USED even if trialUsed was reset/changed to a number', async () => {
  const sub = { userId: 'u1', plan: 'free', trialPlan: 'premium', paymentMethod: 'trial', trialEndDateMs: FAR };
  for (const trialUsed of [false, 0, 3, undefined]) {
    const db = setup({ 'users/u1': trialUsed === undefined ? {} : { trialUsed }, 'subscriptions/u1': sub });
    try {
      const res = await trial({ userId: 'u1' });
      assert.equal(res.statusCode, 409, String(trialUsed));
      assert.equal(res.body.code, 'TRIAL_USED');
      assert.deepEqual(db._get('subscriptions/u1'), sub);
    } finally { teardown(); }
  }
});

test('a new user (no subscription, trial not used) receives the 7-day Premium trial; a numeric AI counter does not count as used', async () => {
  for (const user of [{}, { trialUsed: 2 }, { trialUsed: false }]) {
    const db = setup({ 'users/u1': user });
    try {
      const res = await trial({ userId: 'u1' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      const sub = db._get('subscriptions/u1');
      assert.equal(sub.plan, 'free');
      assert.equal(sub.trialPlan, 'premium');
      assert.equal(sub.paymentMethod, 'trial');
      assert.equal(sub.id, 'trial_u1');
      const days = (sub.trialEndDateMs - Date.now()) / 86400000;
      assert.ok(days > 6.9 && days <= 8, `trial length ~7 days, got ${days}`);
      assert.equal(db._get('users/u1').trialUsed, true);
    } finally { teardown(); }
  }
});

test('a user document that does not exist yet still gets a trial', async () => {
  const db = setup({});
  try {
    const res = await trial({ userId: 'u1' });
    assert.equal(res.statusCode, 200);
    assert.ok(db._get('subscriptions/u1'));
  } finally { teardown(); }
});

test('an error inside the transaction leaves no partial writes and returns 500', async () => {
  const db = setup({ 'users/u1': {} });
  const original = db.runTransaction;
  db.runTransaction = (fn) => original(async (tx) => { await fn(tx); throw new Error('boom'); });
  try {
    const before = snapshotOf(db);
    const res = await trial({ userId: 'u1' });
    assert.equal(res.statusCode, 500);
    assert.equal(snapshotOf(db), before);
  } finally { teardown(); }
});

test('invalid Firebase ID token: 401 and nothing is read-modified', async () => {
  const db = setup({ 'users/u1': {} }, async () => { const e = new Error('x'); e.code = 'auth/argument-error'; throw e; });
  try {
    const before = snapshotOf(db);
    const res = await trial({ userId: 'u1' });
    assert.equal(res.statusCode, 401);
    assert.equal(snapshotOf(db), before);
  } finally { teardown(); }
});

test('a token for another uid cannot start a trial for a different user: 403, their paid subscription intact', async () => {
  const sub = { userId: 'user-b', plan: 'premium', status: 'active', endDateMs: FAR, paymentMethod: 'sbp' };
  const db = setup({ 'users/user-b': {}, 'subscriptions/user-b': sub }, async () => ({ uid: 'user-a' }));
  try {
    const res = await trial({ userId: 'user-b' });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(db._get('subscriptions/user-b'), sub);
    assert.equal(db._keys('subscriptions/').length, 1);
  } finally { teardown(); }
});

test('requests without a token get the same subscription protection', async () => {
  const sub = { userId: 'u1', plan: 'premium', status: 'active', endDateMs: FAR, paymentMethod: 'sbp' };
  const db = setup({ 'users/u1': {}, 'subscriptions/u1': sub });
  try {
    const res = await trial({ userId: 'u1' }, null);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(db._get('subscriptions/u1'), sub);
  } finally { teardown(); }
});
