'use strict';

// Covers api/payment/[action].js:handleCallback's CONFIRMED branch, in
// particular the cross-rail extension fix (Telegram Stars Audit §10/§27):
// an SBP payment must extend from max(now, currentEndDate), the same rule
// Stars now uses — so switching rails never shortens a subscription.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = [
  '../[action]',
  '../../_lib/referral/influencer',
  '../../_lib/referral/partners',
  '../../_lib/referral/codes',
  '../../_lib/referral/earnings',
  '../../_lib/promoCodes',
  '../../_lib/platega',
  '../../_lib/subscription/extend',
  '../../_lib/stars/config',
  '../../_lib/stars/sessions',
];

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.PLATEGA_MERCHANT_ID = 'merchant1';
  process.env.PLATEGA_SECRET = 'secret1';
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.PLATEGA_MERCHANT_ID;
  delete process.env.PLATEGA_SECRET;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq({ body }) {
  return {
    method: 'POST', query: { action: 'callback' }, body,
    headers: { 'x-merchantid': 'merchant1', 'x-secret': 'secret1' },
  };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const DAY_MS = 24 * 60 * 60 * 1000;

test('handleCallback: CONFIRMED with no existing subscription extends from now', async () => {
  const db = injectMockDb({
    'payments/pay1': { userId: 'u1', transactionId: 'pay1', plan: 'pro', period: 'month', amount: 750, status: 'PENDING' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { id: 'pay1', amount: 750, status: 'CONFIRMED' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const sub = db._get('subscriptions/u1');
    assert.equal(sub.status, 'active');
    assert.ok(sub.endDateMs > Date.now() + 29 * DAY_MS);
  } finally { teardown(); }
});

test('handleCallback: SBP payment extends from an EXISTING Stars subscription endDate, not from now (cross-rail)', async () => {
  const futureMs = Date.now() + 20 * DAY_MS;
  const db = injectMockDb({
    'subscriptions/u1': { plan: 'pro', status: 'active', lastPaymentMethod: 'stars', endDateMs: futureMs, startDate: new Date().toISOString() },
    'payments/pay1': { userId: 'u1', transactionId: 'pay1', plan: 'pro', period: 'month', amount: 750, status: 'PENDING' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { id: 'pay1', amount: 750, status: 'CONFIRMED' } });
    const res = mockRes();
    await handler(req, res);

    const sub = db._get('subscriptions/u1');
    assert.equal(sub.endDateMs, futureMs + 30 * DAY_MS, 'SBP must extend from the Stars endDate, not reset to now+30');
    assert.equal(sub.lastPaymentMethod, 'sbp');
  } finally { teardown(); }
});

test('handleCallback: a replayed CONFIRMED for an already-CONFIRMED payment is a no-op', async () => {
  const db = injectMockDb({
    'payments/pay1': { userId: 'u1', transactionId: 'pay1', plan: 'pro', period: 'month', amount: 750, status: 'CONFIRMED' },
    'subscriptions/u1': { plan: 'pro', status: 'active', endDateMs: Date.now() + 30 * DAY_MS },
  });
  try {
    const handler = require('../[action]');
    const before = db._get('subscriptions/u1').endDateMs;
    const req = mockReq({ body: { id: 'pay1', amount: 750, status: 'CONFIRMED' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(db._get('subscriptions/u1').endDateMs, before, 'must not extend again on replay');
  } finally { teardown(); }
});
