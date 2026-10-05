'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_UNDER_TEST = require.resolve('../telegram');
const FIREBASE_ADMIN_PATH = require.resolve('../../_lib/firebaseAdmin');

// Same require.cache injection pattern used throughout api/_lib/referral/__tests__.
// mockAdmin (fixtures.js) only stubs firestore.* — telegramAuthHandler also
// calls admin.auth().createCustomToken(uid), so extend it here.
function injectMockDb(seed) {
  const db = createMockDb(seed);
  const adminWithAuth = {
    ...mockAdmin,
    auth: () => ({ createCustomToken: async (uid) => `mock-custom-token-for-${uid}` }),
  };
  require.cache[FIREBASE_ADMIN_PATH] = {
    id: FIREBASE_ADMIN_PATH, filename: FIREBASE_ADMIN_PATH, loaded: true,
    exports: { db, admin: adminWithAuth },
  };
  delete require.cache[MODULE_UNDER_TEST];
  return db;
}
function teardown() {
  delete require.cache[FIREBASE_ADMIN_PATH];
  delete require.cache[MODULE_UNDER_TEST];
}


const BOT_TOKEN = '123456:TEST-BOT-TOKEN-abcDEF';

function signInitData(fields) {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function freshFields(overrides = {}) {
  return {
    user: JSON.stringify({ id: 777888999, first_name: 'Тест', username: 'test_user' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

// ── verifyInitData (HMAC + auth_date) ────────────────────────────────────────

test('verifyInitData: accepts a correctly signed, fresh initData string', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const initData = signInitData(freshFields());
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, true);
  } finally { teardown(); }
});

test('verifyInitData: rejects a tampered field (bad signature)', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const initData = signInitData(freshFields());
    const params = new URLSearchParams(initData);
    params.set('user', JSON.stringify({ id: 1, first_name: 'Attacker' }));
    const result = verifyInitData(params.toString(), BOT_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  } finally { teardown(); }
});

test('verifyInitData: rejects a payload signed with the wrong bot token', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const initData = signInitData(freshFields());
    const result = verifyInitData(initData, 'different-bot-token');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');
  } finally { teardown(); }
});

test('verifyInitData: rejects missing hash', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const params = new URLSearchParams(freshFields());
    const result = verifyInitData(params.toString(), BOT_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_hash');
  } finally { teardown(); }
});

test('verifyInitData: rejects an expired auth_date (>24h old) even with a valid signature', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const dayAndAHalfAgo = Math.floor(Date.now() / 1000) - 36 * 60 * 60;
    const initData = signInitData(freshFields({ auth_date: String(dayAndAHalfAgo) }));
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  } finally { teardown(); }
});

test('verifyInitData: accepts auth_date right at the edge of the freshness window', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const almostADayAgo = Math.floor(Date.now() / 1000) - (24 * 60 * 60 - 60);
    const initData = signInitData(freshFields({ auth_date: String(almostADayAgo) }));
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, true);
  } finally { teardown(); }
});

test('verifyInitData: rejects a non-numeric auth_date', () => {
  injectMockDb({});
  try {
    const { verifyInitData } = require('../telegram');
    const initData = signInitData(freshFields({ auth_date: 'not-a-number' }));
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_auth_date');
  } finally { teardown(); }
});

// ── resolveCanonicalUid: exhaustive existing-account lookup ──────────────────
// See TELEGRAM_PASSWORDLESS_AUTOAUTH audit §4/§7/§8 — these are exactly the
// scenarios that would otherwise silently create a duplicate account for an
// existing user.

test('resolveCanonicalUid: finds an existing user via numeric chatId', async () => {
  injectMockDb({ 'users/uidNumeric': { chatId: 42, isPro: false } });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.uid, 'uidNumeric');
    assert.equal(result.isNewUser, false);
    assert.equal(result.conflict, false);
  } finally { teardown(); }
});

test('resolveCanonicalUid: finds an existing user via STRING chatId (legacy type mismatch)', async () => {
  // webhook.js's own [5] USER LOOKUP has carried a chatId-as-string fallback
  // for a long time — proof some real user docs have chatId stored as a
  // string, not a number. resolveCanonicalUid must check both or it will
  // "not find" a real existing account and create a duplicate.
  injectMockDb({ 'users/uidStringChatId': { chatId: '42', isPro: false } });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.uid, 'uidStringChatId');
    assert.equal(result.isNewUser, false);
  } finally { teardown(); }
});

test('resolveCanonicalUid: finds an existing user via the telegramUsers mapping when chatId is absent', async () => {
  // Covers an email/password user whose users/{uid} doc never got a chatId
  // field at all, but who previously opened the Mini App once (App.tsx
  // writes telegramUsers/tg_<id> -> { firebaseUid } for ANY authenticated
  // session with Telegram context, regardless of how they originally signed up).
  injectMockDb({
    'users/emailSignupUid': { email: 'someone@example.com', isPro: false },
    'telegramUsers/tg_42': { firebaseUid: 'emailSignupUid' },
  });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.uid, 'emailSignupUid');
    assert.equal(result.isNewUser, false);
  } finally { teardown(); }
});

test('resolveCanonicalUid: ignores a telegramUsers mapping that points at a deleted account', async () => {
  injectMockDb({
    'telegramUsers/tg_42': { firebaseUid: 'deletedUid' }, // no users/deletedUid doc exists
  });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.isNewUser, true);
    assert.equal(result.uid, 'tg_42');
  } finally { teardown(); }
});

test('resolveCanonicalUid: a genuinely new Telegram id gets a deterministic uid, never random', async () => {
  injectMockDb({});
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(999999);
    assert.equal(result.uid, 'tg_999999');
    assert.equal(result.isNewUser, true);
    assert.equal(result.conflict, false);
  } finally { teardown(); }
});

test('resolveCanonicalUid: caches the resolution in canonicalUids so a second call is a single fast read', async () => {
  const db = injectMockDb({ 'users/uidA': { chatId: 42, isPro: false } });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const first = await resolveCanonicalUid(42);
    assert.equal(first.uid, 'uidA');
    assert.ok(db._get('canonicalUids/tg_42'));
    assert.equal(db._get('canonicalUids/tg_42').uid, 'uidA');

    // Even if a second, DIFFERENT user doc with a matching chatId shows up
    // later (shouldn't happen, but), the cached canonical mapping must win —
    // resolution for a given Telegram id is locked in the first time, ever.
    db._store.set('users/uidB', { chatId: 42, isPro: false });
    const second = await resolveCanonicalUid(42);
    assert.equal(second.uid, 'uidA');
  } finally { teardown(); }
});

test('resolveCanonicalUid: two distinct existing accounts for the same Telegram id is flagged as a conflict, never a random pick or a third account', async () => {
  const past = { toMillis: () => 1000 };
  const recent = { toMillis: () => 2000 };
  injectMockDb({
    'users/uidOld':    { chatId: 42, isPro: false, updatedAt: past },
    'users/uidRecent': { chatId: '42', isPro: false, updatedAt: recent },
  });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.conflict, true);
    assert.equal(result.isNewUser, false);
    // Documented heuristic: most-recently-updated (no active sub on either) wins.
    assert.equal(result.uid, 'uidRecent');
  } finally { teardown(); }
});

test('resolveCanonicalUid: conflict resolution prefers the account with an active subscription', async () => {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  injectMockDb({
    'users/uidFreeNewer':  { chatId: 42, isPro: false, updatedAt: { toMillis: () => 5000 } },
    'users/uidProOlder':   {
      chatId: '42', isPro: true, updatedAt: { toMillis: () => 1000 },
      subscription: { status: 'active', endDate: future },
    },
  });
  try {
    const { resolveCanonicalUid } = require('../telegram');
    const result = await resolveCanonicalUid(42);
    assert.equal(result.conflict, true);
    assert.equal(result.uid, 'uidProOlder');
  } finally { teardown(); }
});

// ── setupNewUserIfNeeded: idempotency / no duplicate work under concurrency ──

test('setupNewUserIfNeeded: creates the user + trial subscription exactly once', async () => {
  const db = injectMockDb({});
  try {
    const { setupNewUserIfNeeded } = require('../telegram');
    const tgUser = { id: 555, first_name: 'Нова', username: 'nova' };
    const created = await setupNewUserIfNeeded('tg_555', tgUser, null);
    assert.equal(created, true);
    assert.ok(db._get('users/tg_555'));
    assert.ok(db._get('subscriptions/tg_555'));
  } finally { teardown(); }
});

test('setupNewUserIfNeeded: a second call for an already-set-up account is a no-op', async () => {
  const db = injectMockDb({});
  try {
    const { setupNewUserIfNeeded } = require('../telegram');
    const tgUser = { id: 555, first_name: 'Нова' };
    await setupNewUserIfNeeded('tg_555', tgUser, null);
    const subAfterFirst = { ...db._get('subscriptions/tg_555') };

    const createdSecondTime = await setupNewUserIfNeeded('tg_555', tgUser, null);
    assert.equal(createdSecondTime, false);
    // Subscription doc must be untouched by the second call.
    assert.deepEqual(db._get('subscriptions/tg_555'), subAfterFirst);
  } finally { teardown(); }
});

test('setupNewUserIfNeeded: two "concurrent" calls for a brand-new user never produce two different outcomes', async () => {
  // This mock's runTransaction isn't truly concurrent (no interleaving), but
  // it exercises the exact fix (tx.get instead of a pre-fetched snapshot) —
  // sequential calls after the fix behave identically to what a real
  // Firestore transaction retry would converge to: exactly one creation.
  const db = injectMockDb({});
  try {
    const { setupNewUserIfNeeded } = require('../telegram');
    const tgUser = { id: 777, first_name: 'Двое' };
    const [first, second] = [
      await setupNewUserIfNeeded('tg_777', tgUser, null),
      await setupNewUserIfNeeded('tg_777', tgUser, null),
    ];
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(db._count('subscriptions/tg_777'), 1);
  } finally { teardown(); }
});

// ── Full handler: end-to-end existing-user vs new-user vs invalid-initData ──

test('telegramAuthHandler: existing Telegram user signs in to their existing uid, no new account', async () => {
  injectMockDb({ 'users/existingUid': { chatId: 777888999, isPro: false } });
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  try {
    const handler = require('../telegram');
    const initData = signInitData(freshFields());
    const req = { method: 'POST', body: { initData } };
    let statusCode, jsonBody;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
    };
    await handler(req, res);
    assert.equal(statusCode, 200);
    assert.equal(jsonBody.uid, 'existingUid');
  } finally { delete process.env.TELEGRAM_BOT_TOKEN; teardown(); }
});

test('telegramAuthHandler: invalid initData creates no account and returns 401', async () => {
  const db = injectMockDb({});
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  try {
    const handler = require('../telegram');
    const req = { method: 'POST', body: { initData: 'garbage=1&hash=deadbeef' } };
    let statusCode, jsonBody;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { jsonBody = body; return this; },
    };
    await handler(req, res);
    assert.equal(statusCode, 401);
    assert.equal(db._count('users/'), 0);
  } finally { delete process.env.TELEGRAM_BOT_TOKEN; teardown(); }
});
