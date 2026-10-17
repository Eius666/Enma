'use strict';

// Rollout-mode behaviour of POST /api/payment/create and /trial, driven
// through the real router with an in-memory Firestore and a mocked Admin auth.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = [
  '../[action]', '../../_lib/auth/paymentAuth', '../../_lib/referral/influencer', '../../_lib/referral/partners',
  '../../_lib/referral/codes', '../../_lib/promoCodes', '../../_lib/platega', '../../_lib/subscription/extend',
  '../../_lib/stars/config', '../../_lib/stars/sessions',
];
const JWT = 'aaaa.bbbb.cccc';

function setup(seed, verifyIdToken) {
  const db = createMockDb(seed);
  const calls = { verify: 0 };
  const admin = { ...mockAdmin, auth: () => ({ verifyIdToken: async (t) => { calls.verify++; return verifyIdToken(t); } }) };
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin } };
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return { db, calls };
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}
const req = (action, body, authorization) => ({ method: 'POST', query: { action }, body, headers: authorization === undefined ? {} : { authorization } });
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() {} };
}
async function run(r) {
  const orig = console.log; console.log = () => {};
  try { const res = mockRes(); await require('../[action]')(r, res); return res; } finally { console.log = orig; }
}
const nothingWritten = (db) => db._keys('payments/').length === 0 && db._keys('subscriptions/').length === 0;
const BAL = { 'users/u1': { referralBalance: 10000 }, 'users/user-b': { referralBalance: 10000 } };

test('create without a token is processed as before (rollout mode)', async () => {
  const { db, calls } = setup(BAL, async () => ({ uid: 'u1' }));
  try {
    const res = await run(req('create', { userId: 'u1', plan: 'pro', period: 'month', useBalance: true }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.activated, true);
    assert.equal(calls.verify, 0);
    assert.equal(db._keys('subscriptions/').length, 1);
  } finally { teardown(); }
});

test('create with a valid token and matching userId: processed', async () => {
  const { db } = setup(BAL, async () => ({ uid: 'u1' }));
  try {
    const res = await run(req('create', { userId: 'u1', plan: 'pro', period: 'month', useBalance: true }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 200);
    assert.ok(db._get('subscriptions/u1'));
  } finally { teardown(); }
});

test('create with a valid token and NO body userId: the verified uid is used', async () => {
  const { db } = setup(BAL, async () => ({ uid: 'u1' }));
  try {
    const res = await run(req('create', { plan: 'pro', period: 'month', useBalance: true }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 200);
    assert.ok(db._get('subscriptions/u1'));
  } finally { teardown(); }
});

test('create with a valid token for another user: 403, nothing written, the other user balance untouched', async () => {
  const { db } = setup(BAL, async () => ({ uid: 'user-a' }));
  try {
    const res = await run(req('create', { userId: 'user-b', plan: 'pro', period: 'month', useBalance: true }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 403);
    assert.ok(nothingWritten(db));
    assert.equal(db._get('users/user-b').referralBalance, 10000);
  } finally { teardown(); }
});

test('create with expired / invalid tokens: 401, nothing written', async () => {
  for (const code of ['auth/id-token-expired', 'auth/argument-error']) {
    const { db } = setup(BAL, async () => { const e = new Error('x'); e.code = code; throw e; });
    try {
      const res = await run(req('create', { userId: 'u1', plan: 'pro', useBalance: true }, `Bearer ${JWT}`));
      assert.equal(res.statusCode, 401, code);
      assert.ok(nothingWritten(db));
    } finally { teardown(); }
  }
});

test('create with a malformed Authorization header: 401, verifier not called', async () => {
  const { db, calls } = setup(BAL, async () => ({ uid: 'u1' }));
  try {
    const res = await run(req('create', { userId: 'u1', plan: 'pro', useBalance: true }, 'Basic abc'));
    assert.equal(res.statusCode, 401);
    assert.equal(calls.verify, 0);
    assert.ok(nothingWritten(db));
  } finally { teardown(); }
});

test('create when the Admin verifier is down: controlled 503, no fallback', async () => {
  const { db } = setup(BAL, async () => { throw new Error('network'); });
  try {
    const res = await run(req('create', { userId: 'u1', plan: 'pro', useBalance: true }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 503);
    assert.ok(nothingWritten(db));
  } finally { teardown(); }
});

test('create without token and without userId: still 400', async () => {
  const { db } = setup(BAL, async () => ({ uid: 'u1' }));
  try {
    const res = await run(req('create', { plan: 'pro' }));
    assert.equal(res.statusCode, 400);
    assert.ok(nothingWritten(db));
  } finally { teardown(); }
});

test('trial without a token: processed as before, trial created', async () => {
  const { db } = setup({ 'users/n1': {} }, async () => ({ uid: 'n1' }));
  try {
    const res = await run(req('trial', { userId: 'n1' }));
    assert.equal(res.statusCode, 200);
    assert.equal(db._get('subscriptions/n1').trialPlan, 'premium');
  } finally { teardown(); }
});

test('trial with a valid token: uid from the token (userId may be omitted)', async () => {
  const { db } = setup({ 'users/n1': {} }, async () => ({ uid: 'n1' }));
  try {
    const res = await run(req('trial', {}, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 200);
    assert.ok(db._get('subscriptions/n1'));
  } finally { teardown(); }
});

test('trial with a token for another user: 403 and the target subscription is untouched', async () => {
  const paid = { plan: 'premium', status: 'active', endDateMs: 4102444800000 };
  const { db } = setup({ 'users/user-b': {}, 'subscriptions/user-b': paid }, async () => ({ uid: 'user-a' }));
  try {
    const res = await run(req('trial', { userId: 'user-b' }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(db._get('subscriptions/user-b'), paid);
    assert.equal(db._keys('subscriptions/').length, 1);
  } finally { teardown(); }
});

test('trial with invalid token: 401, nothing written', async () => {
  const { db } = setup({ 'users/n1': {} }, async () => { const e = new Error('x'); e.code = 'auth/argument-error'; throw e; });
  try {
    const res = await run(req('trial', { userId: 'n1' }, `Bearer ${JWT}`));
    assert.equal(res.statusCode, 401);
    assert.ok(nothingWritten(db));
  } finally { teardown(); }
});

test('GET variants of /create (promo validation, status poll) are not affected', async () => {
  const { calls } = setup({}, async () => ({ uid: 'u1' }));
  try {
    const res = await run({ method: 'GET', query: { action: 'create', transactionId: 't', uid: 'u1' }, headers: {} });
    assert.notEqual(res.statusCode, 401);
    assert.equal(calls.verify, 0);
  } finally { teardown(); }
});
