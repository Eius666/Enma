'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// verifyInitData is a pure function and never touches Firestore/Firebase
// Auth, but ../telegram.js requires firebaseAdmin unconditionally at module
// load — mock it out so this test doesn't need real credentials, same
// require.cache injection pattern used throughout api/_lib/referral/__tests__.
const fa = require.resolve('../../_lib/firebaseAdmin');
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: {}, admin: {} } };

const { verifyInitData } = require('../telegram');

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-abcDEF';

// Independent re-implementation of the Mini App initData signature (distinct
// from the Login Widget scheme in partnerAuth.js: secret = HMAC-SHA256('Web
// AppData', bot_token), not SHA256(bot_token) directly) — Telegram's own
// documented algorithm, built here rather than calling the code under test.
function signInitData(fields) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

function freshFields(overrides = {}) {
  return {
    user: JSON.stringify({ id: 777888999, first_name: 'Тест', username: 'test_user' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

test('verifyInitData: accepts a correctly signed, fresh initData string', () => {
  const initData = signInitData(freshFields());
  const result = verifyInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.params.get('auth_date'), freshFields().auth_date);
});

test('verifyInitData: rejects a tampered field (bad signature)', () => {
  const initData = signInitData(freshFields());
  const params = new URLSearchParams(initData);
  params.set('user', JSON.stringify({ id: 1, first_name: 'Attacker' })); // tamper after signing
  const result = verifyInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('verifyInitData: rejects a payload signed with the wrong bot token', () => {
  const initData = signInitData(freshFields());
  const result = verifyInitData(initData, 'different-bot-token');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('verifyInitData: rejects missing hash', () => {
  const params = new URLSearchParams(freshFields());
  const result = verifyInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_hash');
});

test('verifyInitData: rejects an expired auth_date (>24h old) even with a valid signature', () => {
  const dayAndAHalfAgo = Math.floor(Date.now() / 1000) - 36 * 60 * 60;
  const initData = signInitData(freshFields({ auth_date: String(dayAndAHalfAgo) }));
  const result = verifyInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('verifyInitData: accepts auth_date right at the edge of the freshness window', () => {
  const almostADayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60 - 60);
  const initData = signInitData(freshFields({ auth_date: String(almostADayAgo) }));
  const result = verifyInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, true);
});

test('verifyInitData: rejects a non-numeric auth_date', () => {
  const initData = signInitData(freshFields({ auth_date: 'not-a-number' }));
  const result = verifyInitData(initData, BOT_TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_auth_date');
});
