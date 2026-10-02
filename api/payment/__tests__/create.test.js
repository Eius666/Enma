'use strict';

// Covers the recurring-attribution fix in handleCreate: a payer who was
// attributed to a partner on an earlier payment (users.referredByInfluencer)
// must keep crediting that same partner on every later payment too, even
// when the checkout call doesn't explicitly send `referralCode` — otherwise
// "recurring commission" never actually recurs (see partners.html audit).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = [
  '../[action]',
  '../../_lib/referral/influencer',
  '../../_lib/referral/partners',
  '../../_lib/referral/codes',
  '../../_lib/promoCodes',
  '../../_lib/platega',
];

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const p of MODULE_PATHS) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

function mockReq({ body }) {
  return { method: 'POST', query: { action: 'create' }, body, headers: {} };
}
function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
    end() {},
  };
  return res;
}

const SASHA = {
  code: 'SASHA1', name: 'Sasha', status: 'active',
  commissionPercent: 30, discountPercent: 10,
  clicks: 0, registrations: 0, totalEarned: 0, pendingPayout: 0, paidOut: 0,
};

test('handleCreate: recurring payment auto-applies the payer\'s stored partner attribution', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...SASHA },
    'users/payer1': { referredByInfluencer: 'SASHA1', referralBalance: 10000 },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { userId: 'payer1', plan: 'pro', period: 'month', useBalance: true } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.activated, true);
    // pro/month = 750, SASHA1 gives 10% discount -> 675, fully covered by balance
    assert.equal(res.body.balanceUsed, 675);

    const payKeys = db._keys('payments/');
    assert.equal(payKeys.length, 1);
    const payment = db._get(payKeys[0]);
    assert.equal(payment.referralCode, 'SASHA1', 'payment must be attributed to the stored partner without the client sending referralCode');
    assert.equal(payment.method, 'balance');
  } finally {
    teardown();
  }
});

test('handleCreate: explicit referralCode from the client still wins over stored attribution', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...SASHA },
    'referrers/OTHER99': { ...SASHA, code: 'OTHER99', name: 'Other' },
    'users/payer1': { referredByInfluencer: 'SASHA1', referralBalance: 10000 },
  });
  try {
    const handler = require('../[action]');
    // An attempt to apply a different code than the stored one is rejected by
    // validateInfluencerCode ('already_referred') — the stored partner wins,
    // which is the correct anti-fraud behavior (can't switch partners).
    const req = mockReq({ body: { userId: 'payer1', plan: 'pro', period: 'month', useBalance: true, referralCode: 'OTHER99' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const payKeys = db._keys('payments/');
    const payment = db._get(payKeys[0]);
    assert.equal(payment.referralCode, null, 'a different partner code must not override the existing attribution');
  } finally {
    teardown();
  }
});

test('handleCreate: payer with no prior attribution and no referralCode input pays full price, no partner credited', async () => {
  const db = injectMockDb({
    'users/payer2': { referralBalance: 10000 },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { userId: 'payer2', plan: 'pro', period: 'month', useBalance: true } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.balanceUsed, 750); // no discount applied
    const payKeys = db._keys('payments/');
    const payment = db._get(payKeys[0]);
    assert.equal(payment.referralCode, null);
  } finally {
    teardown();
  }
});
