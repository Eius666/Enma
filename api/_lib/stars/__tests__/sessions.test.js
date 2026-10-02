'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');

const MODULE_PATHS = ['../sessions', '../config'];

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

// Canonical USD prices (mirrors PLANS in src/subscription.ts) and their
// correct Stars prices at the $0.013 developer reward rate, rounded up to
// the nearest 10 XTR: 8/0.013=615.38→620, 11/0.013=846.15→850.
const PRO_STARS = 620;
const PREMIUM_STARS = 850;

test('starsPriceFor: pro/month and premium/month are DIFFERENT, each computed from its own real USD price', () => {
  const db = injectMockDb({});
  try {
    const { starsPriceFor, isValidStarsPlan } = require('../config');
    assert.equal(starsPriceFor('pro', 'month'), PRO_STARS);
    assert.equal(starsPriceFor('premium', 'month'), PREMIUM_STARS);
    assert.notEqual(starsPriceFor('pro', 'month'), starsPriceFor('premium', 'month'));
    assert.equal(isValidStarsPlan('pro', 'month'), true);
    assert.equal(isValidStarsPlan('premium', 'month'), true);
  } finally { teardown(); }
});

test('starsPriceFor: unsupported plan/period combos return null — no invented prices', () => {
  const db = injectMockDb({});
  try {
    const { starsPriceFor, isValidStarsPlan } = require('../config');
    assert.equal(starsPriceFor('pro', 'year'), null, 'no yearly Stars product exists');
    assert.equal(starsPriceFor('free', 'month'), null);
    assert.equal(starsPriceFor('nonsense', 'month'), null);
    assert.equal(isValidStarsPlan('pro', 'year'), false);
  } finally { teardown(); }
});

test('sessionIdFromPayload: recognizes a well-formed enma_stars payload', () => {
  const db = injectMockDb({});
  try {
    const { payloadFor, sessionIdFromPayload } = require('../sessions');
    const id = 'a'.repeat(32);
    assert.equal(sessionIdFromPayload(payloadFor(id)), id);
  } finally { teardown(); }
});

test('sessionIdFromPayload: rejects legacy and garbage payloads', () => {
  const db = injectMockDb({});
  try {
    const { sessionIdFromPayload } = require('../sessions');
    assert.equal(sessionIdFromPayload('enma_sub_12345_1700000000000'), null);
    assert.equal(sessionIdFromPayload('garbage'), null);
    assert.equal(sessionIdFromPayload(''), null);
    assert.equal(sessionIdFromPayload(undefined), null);
    assert.equal(sessionIdFromPayload('enma_stars:not-hex'), null);
  } finally { teardown(); }
});

test('createPaymentSession: Pro session uses the Pro price (620), records the USD reference and reward rate', async () => {
  const db = injectMockDb({});
  try {
    const { createPaymentSession, getPaymentSession, sessionIdFromPayload } = require('../sessions');
    const session = await createPaymentSession({ userId: 'u1', telegramUserId: 555, plan: 'pro', period: 'month' });
    assert.equal(session.starsAmount, PRO_STARS);
    assert.equal(sessionIdFromPayload(session.payload), session.sessionId);

    const fetched = await getPaymentSession(session.sessionId);
    assert.equal(fetched.userId, 'u1');
    assert.equal(fetched.telegramUserId, 555);
    assert.equal(fetched.plan, 'pro');
    assert.equal(fetched.status, 'created');
    assert.equal(fetched.currency, 'XTR');
    assert.equal(fetched.usdReferencePrice, 8);
    assert.equal(fetched.starRewardRate, 0.013);
  } finally { teardown(); }
});

test('createPaymentSession: Premium session uses the Premium price (850), not Pro\'s', async () => {
  const db = injectMockDb({});
  try {
    const { createPaymentSession, getPaymentSession } = require('../sessions');
    const session = await createPaymentSession({ userId: 'u1', telegramUserId: 555, plan: 'premium', period: 'month' });
    assert.equal(session.starsAmount, PREMIUM_STARS);

    const fetched = await getPaymentSession(session.sessionId);
    assert.equal(fetched.plan, 'premium');
    assert.equal(fetched.usdReferencePrice, 11);
    assert.equal(fetched.starRewardRate, 0.013);
  } finally { teardown(); }
});

test('createPaymentSession: rejects a plan/period with no configured Stars price', async () => {
  const db = injectMockDb({});
  try {
    const { createPaymentSession } = require('../sessions');
    await assert.rejects(
      () => createPaymentSession({ userId: 'u1', telegramUserId: 555, plan: 'premium', period: 'year' }),
      (err) => err.code === 'invalid_plan'
    );
  } finally { teardown(); }
});

test('isSessionExpired: true past expiresAtMs, false before it', () => {
  const db = injectMockDb({});
  try {
    const { isSessionExpired } = require('../sessions');
    const now = Date.now();
    assert.equal(isSessionExpired({ expiresAtMs: now - 1000 }, now), true);
    assert.equal(isSessionExpired({ expiresAtMs: now + 1000 }, now), false);
    assert.equal(isSessionExpired({}, now), true, 'missing expiresAtMs must fail closed');
  } finally { teardown(); }
});
