'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');

const MODULE_PATHS = ['../payments', '../sessions', '../config', '../../subscription/extend'];

function injectMockDb(seed, env = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown(envKeys = []) {
  try { delete require.cache[require.resolve('../../firebaseAdmin')]; } catch (_) {}
  for (const k of envKeys) delete process.env[k];
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeSession(overrides = {}) {
  const { createPaymentSession } = require('../sessions');
  return createPaymentSession({
    userId: 'u1', telegramUserId: 555, plan: 'pro', period: 'month', ...overrides,
  });
}

// ── validatePreCheckoutQuery ─────────────────────────────────────────────────

test('validatePreCheckoutQuery: valid session is accepted', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: session.payload, currency: 'XTR', total_amount: 1000, from: { id: 555 },
    });
    assert.equal(r.ok, true);
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: nonexistent session rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { validatePreCheckoutQuery } = require('../payments');
    const { payloadFor } = require('../sessions');
    const r = await validatePreCheckoutQuery({
      invoice_payload: payloadFor('b'.repeat(32)), currency: 'XTR', total_amount: 1000, from: { id: 555 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'session_not_found');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: expired session rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    db._get(`stars_payment_sessions/${session.sessionId}`).expiresAtMs = Date.now() - 1000;
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: session.payload, currency: 'XTR', total_amount: 1000, from: { id: 555 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'session_expired');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: wrong amount rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: session.payload, currency: 'XTR', total_amount: 1, from: { id: 555 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'amount_mismatch');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: wrong currency rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: session.payload, currency: 'RUB', total_amount: 1000, from: { id: 555 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong_currency');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: wrong Telegram user rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: session.payload, currency: 'XTR', total_amount: 1000, from: { id: 999 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'telegram_user_mismatch');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validatePreCheckoutQuery: malformed/unrecognized payload rejected', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { validatePreCheckoutQuery } = require('../payments');
    const r = await validatePreCheckoutQuery({
      invoice_payload: 'totally_not_ours', currency: 'XTR', total_amount: 1000, from: { id: 555 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unrecognized_payload');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validateLegacyPreCheckout: well-formed legacy payload at the right price is accepted', () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { validateLegacyPreCheckout } = require('../payments');
    const r = validateLegacyPreCheckout({ invoice_payload: 'enma_sub_555_1700000000000', currency: 'XTR', total_amount: 1000 });
    assert.equal(r.ok, true);
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('validateLegacyPreCheckout: tampered amount rejected', () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { validateLegacyPreCheckout } = require('../payments');
    const r = validateLegacyPreCheckout({ invoice_payload: 'enma_sub_555_1700000000000', currency: 'XTR', total_amount: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'amount_mismatch');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

// ── processStarsSuccessfulPayment ────────────────────────────────────────────

test('processStarsSuccessfulPayment: valid payment activates Pro, persists charge id, marks session paid', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment } = require('../payments');

    const r = await processStarsSuccessfulPayment({
      successfulPayment: {
        telegram_payment_charge_id: 'charge_abc123',
        invoice_payload: session.payload,
        total_amount: 1000, currency: 'XTR',
      },
      userId: 'u1', telegramUserId: 555,
    });

    assert.equal(r.ok, true);
    assert.equal(r.alreadyProcessed, false);

    const sub = db._get('subscriptions/u1');
    assert.equal(sub.status, 'active');
    assert.equal(sub.lastPaymentMethod, 'stars');
    assert.ok(sub.endDateMs > Date.now());

    const payment = db._get(`payments/${r.docId}`);
    assert.equal(payment.telegram_payment_charge_id, 'charge_abc123');
    assert.equal(payment.method, 'stars');
    assert.equal(payment.status, 'confirmed');

    const sessionAfter = db._get(`stars_payment_sessions/${session.sessionId}`);
    assert.equal(sessionAfter.status, 'paid');
    assert.equal(sessionAfter.paymentDocId, r.docId);
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('processStarsSuccessfulPayment: IDEMPOTENT — the same charge id processed twice extends the subscription only once', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment } = require('../payments');
    const payload = {
      successfulPayment: {
        telegram_payment_charge_id: 'charge_dup',
        invoice_payload: session.payload,
        total_amount: 1000, currency: 'XTR',
      },
      userId: 'u1', telegramUserId: 555,
    };

    const first  = await processStarsSuccessfulPayment(payload);
    const sub1   = { ...db._get('subscriptions/u1') };
    const second = await processStarsSuccessfulPayment(payload);
    const sub2   = db._get('subscriptions/u1');

    assert.equal(first.alreadyProcessed, false);
    assert.equal(second.alreadyProcessed, true, 'a replayed update must be a no-op');
    assert.equal(sub2.endDateMs, sub1.endDateMs, 'subscription must not be extended twice');
    assert.equal(db._keys('payments/').length, 1, 'exactly one payment doc for this charge id');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('processStarsSuccessfulPayment: two DIFFERENT charge ids both extend, cumulatively', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { processStarsSuccessfulPayment } = require('../payments');
    const sessionA = await makeSession();
    const a = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_a', invoice_payload: sessionA.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });
    const sessionB = await makeSession();
    const b = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_b', invoice_payload: sessionB.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    assert.equal(db._keys('payments/').length, 2);
    const subAfterA = new Date(a.endDate).getTime();
    const subAfterB = new Date(b.endDate).getTime();
    assert.ok(subAfterB > subAfterA, 'second purchase must extend further, not reset');
    assert.ok(subAfterB - subAfterA >= 29 * DAY_MS, 'extension must be ~30 days on top of the first');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('processStarsSuccessfulPayment: Stars purchase extends from an EXISTING SBP subscription\'s endDate, not from now', async () => {
  const db = injectMockDb({
    'subscriptions/u1': { plan: 'pro', status: 'active', lastPaymentMethod: 'sbp', endDateMs: Date.now() + 20 * DAY_MS, startDate: new Date().toISOString() },
  }, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment } = require('../payments');
    const before = db._get('subscriptions/u1').endDateMs;

    await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_cross_rail', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    const after = db._get('subscriptions/u1').endDateMs;
    assert.equal(after, before + 30 * DAY_MS, 'Stars must extend from the SBP endDate, not reset to now+30');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('processStarsSuccessfulPayment: never touches the old consumer/TON referral ledger or the partner commission ledger', async () => {
  const db = injectMockDb({
    'users/u1': { referredBy: 'FRIEND1' },               // old consumer referral attribution
    'referrals/r1': { referrerId: 'friendUid', referredId: 'u1', status: 'converted' },
  }, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment } = require('../payments');
    await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_isolation', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    assert.equal(db._keys('referral_earnings/').length, 0, 'old consumer/TON commission must NOT fire for Stars');
    assert.equal(db._keys('referralEarnings/').length, 0, 'Enma partner commission must NOT fire for Stars');
    assert.equal(db._get('users/u1').referralBalance, undefined, 'no RUB cashback for Stars');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('processStarsSuccessfulPayment: legacy bot-invoice payload (no session) still activates and is still idempotent', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { processStarsSuccessfulPayment } = require('../payments');
    const legacyPayload = { telegram_payment_charge_id: 'charge_legacy', invoice_payload: 'enma_sub_555_123', total_amount: 1000, currency: 'XTR' };

    const first  = await processStarsSuccessfulPayment({ successfulPayment: legacyPayload, userId: 'u1', telegramUserId: 555 });
    const second = await processStarsSuccessfulPayment({ successfulPayment: legacyPayload, userId: 'u1', telegramUserId: 555 });

    assert.equal(first.alreadyProcessed, false);
    assert.equal(second.alreadyProcessed, true);
    assert.equal(db._get('subscriptions/u1').plan, 'pro');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

// ── refundStarsPayment ───────────────────────────────────────────────────────

test('refundStarsPayment: successful refund marks payment refunded and writes an audit record', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  const originalFetch = global.fetch;
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment, refundStarsPayment } = require('../payments');
    const paid = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_refund_me', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    global.fetch = async () => ({ json: async () => ({ ok: true, result: true }) });
    const r = await refundStarsPayment({ paymentDocId: paid.docId, token: 'fake-token', actor: 'owner' });

    assert.equal(r.ok, true);
    assert.equal(db._get(`payments/${paid.docId}`).status, 'refunded');
    assert.equal(db._keys('stars_refund_audit/').length, 1);
  } finally { global.fetch = originalFetch; teardown(['STAR_PRICE_MONTHLY']); }
});

test('refundStarsPayment: a second refund of the same payment is rejected, no-op', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  const originalFetch = global.fetch;
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment, refundStarsPayment } = require('../payments');
    const paid = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_refund_twice', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    global.fetch = async () => ({ json: async () => ({ ok: true, result: true }) });
    await refundStarsPayment({ paymentDocId: paid.docId, token: 'fake-token', actor: 'owner' });
    const second = await refundStarsPayment({ paymentDocId: paid.docId, token: 'fake-token', actor: 'owner' });

    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already_refunded');
    assert.equal(db._keys('stars_refund_audit/').length, 1, 'no second audit record');
  } finally { global.fetch = originalFetch; teardown(['STAR_PRICE_MONTHLY']); }
});

test('refundStarsPayment: a failed Telegram refund call does not mark the payment refunded', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  const originalFetch = global.fetch;
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment, refundStarsPayment } = require('../payments');
    const paid = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_refund_fail', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    global.fetch = async () => ({ json: async () => ({ ok: false, description: 'CHARGE_NOT_FOUND' }) });
    const r = await refundStarsPayment({ paymentDocId: paid.docId, token: 'fake-token', actor: 'owner' });

    assert.equal(r.ok, false);
    assert.equal(db._get(`payments/${paid.docId}`).status, 'confirmed');
  } finally { global.fetch = originalFetch; teardown(['STAR_PRICE_MONTHLY']); }
});

// ── recalculateSubscriptionEntitlement ──────────────────────────────────────

test('recalculateSubscriptionEntitlement: rolls back the exact extension when it is the most recent one', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  const originalFetch = global.fetch;
  try {
    const session = await makeSession();
    const { processStarsSuccessfulPayment, refundStarsPayment } = require('../payments');
    const paid = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_rollback', invoice_payload: session.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });
    const beforeMs = db._get(`payments/${paid.docId}`).subscriptionEndDateBeforeMs;

    global.fetch = async () => ({ json: async () => ({ ok: true, result: true }) });
    await refundStarsPayment({ paymentDocId: paid.docId, token: 'fake-token', actor: 'owner' });

    const sub = db._get('subscriptions/u1');
    if (beforeMs) {
      assert.equal(sub.endDateMs, beforeMs);
    } else {
      assert.equal(sub.status, 'expired');
    }
  } finally { global.fetch = originalFetch; teardown(['STAR_PRICE_MONTHLY']); }
});

test('recalculateSubscriptionEntitlement: does NOT roll back when a later payment has since extended further', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  const originalFetch = global.fetch;
  try {
    const { processStarsSuccessfulPayment, refundStarsPayment, recalculateSubscriptionEntitlement } = require('../payments');

    const session1 = await makeSession();
    const first = await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_first', invoice_payload: session1.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });

    const session2 = await makeSession();
    await processStarsSuccessfulPayment({
      successfulPayment: { telegram_payment_charge_id: 'charge_second', invoice_payload: session2.payload, total_amount: 1000, currency: 'XTR' },
      userId: 'u1', telegramUserId: 555,
    });
    const subAfterSecond = { ...db._get('subscriptions/u1') };

    // Manually flip the FIRST payment to refunded (bypassing the Telegram call)
    // to isolate recalculateSubscriptionEntitlement's own superseded-check.
    db._store.set(`payments/${first.docId}`, { ...db._get(`payments/${first.docId}`), status: 'refunded' });
    await recalculateSubscriptionEntitlement('u1');

    const subAfterRecalc = db._get('subscriptions/u1');
    assert.equal(subAfterRecalc.endDateMs, subAfterSecond.endDateMs, 'a superseded refund must not touch the current entitlement');
  } finally { global.fetch = originalFetch; teardown(['STAR_PRICE_MONTHLY']); }
});
