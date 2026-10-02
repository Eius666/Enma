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

test('starsPriceFor: pro/month returns the configured STAR_PRICE_MONTHLY', () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { starsPriceFor, isValidStarsPlan } = require('../config');
    assert.equal(starsPriceFor('pro', 'month'), 1000);
    assert.equal(isValidStarsPlan('pro', 'month'), true);
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('starsPriceFor: unsupported plan/period combos return null — no invented prices', () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { starsPriceFor, isValidStarsPlan } = require('../config');
    assert.equal(starsPriceFor('premium', 'month'), null);
    assert.equal(starsPriceFor('pro', 'year'), null);
    assert.equal(isValidStarsPlan('premium', 'month'), false);
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
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

test('createPaymentSession: valid plan writes a session with the server-side price', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { createPaymentSession, getPaymentSession, sessionIdFromPayload } = require('../sessions');
    const session = await createPaymentSession({ userId: 'u1', telegramUserId: 555, plan: 'pro', period: 'month' });
    assert.equal(session.starsAmount, 1000);
    assert.equal(sessionIdFromPayload(session.payload), session.sessionId);

    const fetched = await getPaymentSession(session.sessionId);
    assert.equal(fetched.userId, 'u1');
    assert.equal(fetched.telegramUserId, 555);
    assert.equal(fetched.status, 'created');
    assert.equal(fetched.currency, 'XTR');
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
});

test('createPaymentSession: rejects a plan/period with no configured Stars price', async () => {
  const db = injectMockDb({}, { STAR_PRICE_MONTHLY: '1000' });
  try {
    const { createPaymentSession } = require('../sessions');
    await assert.rejects(
      () => createPaymentSession({ userId: 'u1', telegramUserId: 555, plan: 'premium', period: 'year' }),
      (err) => err.code === 'invalid_plan'
    );
  } finally { teardown(['STAR_PRICE_MONTHLY']); }
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
