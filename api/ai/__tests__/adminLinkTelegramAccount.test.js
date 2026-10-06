'use strict';

// Covers api/ai/[action].js's adminLinkTelegramAccount action — the
// permanent, admin-gated manual recovery tool for attaching a verified
// Telegram identity to a SPECIFIC existing Enma account by email. Writes
// ONLY a telegramManualLinks/tg_<id> document; never creates, deletes, or
// merges an account; never touches finance/tasks/habits/notes/subscriptions.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = ['../[action]', '../../auth/telegram'];
const ADMIN_KEY = 'test-admin-key';

function injectDb(seed = {}, { userByEmail } = {}) {
  const db = createMockDb(seed);
  const adminWithAuth = {
    ...mockAdmin,
    auth: () => ({
      getUserByEmail: async (email) => {
        if (userByEmail && userByEmail[email]) return { uid: userByEmail[email] };
        const err = new Error('no user record');
        err.code = 'auth/user-not-found';
        throw err;
      },
    }),
  };
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: adminWithAuth } };
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.ADMIN_API_KEY;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq({ method = 'POST', headers = {}, body = {} } = {}) {
  return { method, query: { action: 'adminLinkTelegramAccount' }, headers, body };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('adminLinkTelegramAccount: wrong x-admin-key -> 403, no writes', async () => {
  const db = injectDb({}, { userByEmail: { 'owner@example.com': 'ownerUid' } });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': 'wrong' }, body: { email: 'owner@example.com', telegramId: 42 } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(db._get('telegramManualLinks/tg_42'), undefined);
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: GET -> 405 (router-level POST-only gate)', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: missing/invalid email -> 400 INVALID_EMAIL', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { telegramId: 42 } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_EMAIL');
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: missing/invalid telegramId -> 400 INVALID_TELEGRAM_ID', async () => {
  injectDb({}, { userByEmail: { 'owner@example.com': 'ownerUid' } });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'owner@example.com', telegramId: 'not-a-number' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_TELEGRAM_ID');
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: email not found in Firebase Auth -> 404 ACCOUNT_NOT_FOUND, no writes', async () => {
  const db = injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'nobody@example.com', telegramId: 42 } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'ACCOUNT_NOT_FOUND');
    assert.equal(db._get('telegramManualLinks/tg_42'), undefined);
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: creates the manual link and reports a pre-existing conflict without picking a uid', async () => {
  const db = injectDb(
    {
      'users/ownerUid': { email: 'owner@example.com' },
      'users/legacyUidA': { chatId: 999 },
      'users/legacyUidB': { chatId: '999' },
    },
    { userByEmail: { 'owner@example.com': 'ownerUid' } }
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'owner@example.com', telegramId: 999 } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.accountFound, true);
    assert.equal(res.body.enmaUserDocExists, true);
    assert.equal(res.body.candidateExistingAccounts, 2);
    assert.equal(res.body.currentConflict, true);
    assert.equal(res.body.targetEmailAccountAmongCandidates, false, 'ownerUid never had a chatId set — not among the conflicting candidates');
    assert.equal(res.body.manualLinkCreated, true);

    const link = db._get('telegramManualLinks/tg_999');
    assert.equal(link.uid, 'ownerUid');
    assert.equal(link.source, 'owner_manual_recovery');
    assert.equal(link.verified, true);

    // Neither pre-existing conflicting account was touched.
    assert.deepEqual(db._get('users/legacyUidA'), { chatId: 999 });
    assert.deepEqual(db._get('users/legacyUidB'), { chatId: '999' });
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: response never includes the email, telegramId, or raw uid as a bare top-level echo', async () => {
  const db = injectDb(
    { 'users/ownerUid': { email: 'owner@example.com' } },
    { userByEmail: { 'owner@example.com': 'ownerUid' } }
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'owner@example.com', telegramId: 555 } });
    const res = mockRes();
    await handler(req, res);

    const allowedKeys = [
      'ok', 'accountFound', 'enmaUserDocExists', 'candidateExistingAccounts',
      'currentConflict', 'targetEmailAccountAmongCandidates', 'manualLinkCreated',
    ];
    assert.deepEqual(Object.keys(res.body).sort(), allowedKeys.sort());
  } finally { teardown(); }
});

test('adminLinkTelegramAccount: idempotent — linking the same email+telegramId twice is a no-op the second time', async () => {
  const db = injectDb(
    { 'users/ownerUid': { email: 'owner@example.com' } },
    { userByEmail: { 'owner@example.com': 'ownerUid' } }
  );
  try {
    const handler = require('../[action]');
    const req1 = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'owner@example.com', telegramId: 321 } });
    await handler(req1, mockRes());
    const after1 = JSON.stringify(db._get('telegramManualLinks/tg_321'));

    const req2 = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: { email: 'owner@example.com', telegramId: 321 } });
    const res2 = mockRes();
    await handler(req2, res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(JSON.stringify(db._get('telegramManualLinks/tg_321')).replace(/"createdAt":\{[^}]*\}/, ''),
      after1.replace(/"createdAt":\{[^}]*\}/, ''));
  } finally { teardown(); }
});
