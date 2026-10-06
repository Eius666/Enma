'use strict';

// Covers api/ai/[action].js's adminTelegramMappingApply action — the
// one-time, admin-gated migration APPLY for the TELEGRAM_PASSWORDLESS_AUTOAUTH
// effort. Writes ONLY canonicalUids documents (repair stale entries,
// pre-canonicalize already-unique identities); never touches user data;
// never picks/merges/creates an account for an ambiguous case.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = ['../[action]', '../../auth/telegram'];
const ADMIN_KEY = 'test-admin-key';

function injectDb(seed = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
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
  return { method, query: { action: 'adminTelegramMappingApply' }, headers, body };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}
function nonCanonicalEntries(db) {
  return [...db._store.entries()].filter(([k]) => !k.startsWith('canonicalUids/'));
}

test('adminTelegramMappingApply: wrong x-admin-key -> 403 ADMIN_UNAUTHORIZED, no writes', async () => {
  const db = injectDb({ 'users/uidA': { chatId: 1 } });
  try {
    const handler = require('../[action]');
    const before = JSON.stringify([...db._store.entries()]);
    const req = mockReq({ headers: { 'x-admin-key': 'wrong' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, code: 'ADMIN_UNAUTHORIZED' });
    assert.equal(JSON.stringify([...db._store.entries()]), before);
  } finally { teardown(); }
});

test('adminTelegramMappingApply: GET -> 405 (router-level POST-only gate)', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
  } finally { teardown(); }
});

test('adminTelegramMappingApply: repairs a stale canonicalUids entry (deletes it), never touches user data', async () => {
  const db = injectDb({
    'canonicalUids/tg_999': { uid: 'longGoneUid', telegramId: 999 },
    'users/uidOther': { chatId: 1 }, // unrelated, must stay untouched
  });
  try {
    const handler = require('../[action]');
    const otherBefore = JSON.stringify(db._get('users/uidOther'));
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.repaired, 1);
    assert.equal(res.body.failed, 0);
    assert.equal(db._get('canonicalUids/tg_999'), undefined, 'the stale entry was deleted');
    assert.equal(JSON.stringify(db._get('users/uidOther')), otherBefore, 'unrelated user data untouched');
  } finally { teardown(); }
});

test('adminTelegramMappingApply: canonicalizes a genuinely unique, not-yet-cached identity', async () => {
  const db = injectDb({ 'users/uidSolo': { chatId: 42 } });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canonicalized, 1);
    assert.equal(db._get('canonicalUids/tg_42')?.uid, 'uidSolo');
  } finally { teardown(); }
});

test('adminTelegramMappingApply: never writes anything for a conflict (2+ existing accounts) — skippedAmbiguous, no canonicalUids doc', async () => {
  const db = injectDb({
    'users/uidOne': { chatId: 777 },
    'users/uidTwo': { chatId: '777' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.canonicalized, 0);
    assert.equal(res.body.repaired, 0);
    assert.ok(res.body.skippedAmbiguous >= 1);
    assert.equal(db._get('canonicalUids/tg_777'), undefined, 'a conflict must never be cached as a decision');
  } finally { teardown(); }
});

test('adminTelegramMappingApply: never creates an account for an orphaned mapping with no other signal (recovery_required) — skipped, not canonicalized or repaired', async () => {
  const db = injectDb({
    'telegramUsers/tg_555': { firebaseUid: 'ghostUid' }, // orphaned, no other signal at all
  });
  try {
    const handler = require('../[action]');
    const usersCountBefore = nonCanonicalEntries(db).filter(([k]) => k.startsWith('users/')).length;
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    const usersCountAfter = [...db._store.entries()].filter(([k]) => k.startsWith('users/')).length;
    assert.equal(usersCountAfter, usersCountBefore, 'no new account was created');
    assert.equal(res.body.canonicalized, 0);
    assert.equal(res.body.repaired, 0);
  } finally { teardown(); }
});

test('adminTelegramMappingApply: an already-cached unique identity is left alone (not re-counted as canonicalize)', async () => {
  const db = injectDb({
    'users/uidCached': { chatId: 11 },
    'canonicalUids/tg_11': { uid: 'uidCached', telegramId: 11 },
  });
  try {
    const handler = require('../[action]');
    const cachedBefore = JSON.stringify(db._get('canonicalUids/tg_11'));
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.canonicalized, 0, 'already cached — nothing to do');
    assert.equal(JSON.stringify(db._get('canonicalUids/tg_11')), cachedBefore);
  } finally { teardown(); }
});

test('adminTelegramMappingApply: idempotent — running twice yields zero writes the second time', async () => {
  const db = injectDb({
    'users/uidSolo': { chatId: 42 },
    'canonicalUids/tg_999': { uid: 'longGoneUid', telegramId: 999 },
  });
  try {
    const handler = require('../[action]');
    const req1 = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res1 = mockRes();
    await handler(req1, res1);
    assert.equal(res1.body.repaired, 1);
    assert.equal(res1.body.canonicalized, 1);

    const snapshotAfterFirst = JSON.stringify([...db._store.entries()]);

    const req2 = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res2 = mockRes();
    await handler(req2, res2);
    assert.equal(res2.body.repaired, 0);
    assert.equal(res2.body.canonicalized, 0);
    assert.equal(res2.body.failed, 0);
    assert.equal(JSON.stringify([...db._store.entries()]), snapshotAfterFirst, 'second run is a true no-op');
  } finally { teardown(); }
});

test('adminTelegramMappingApply: never writes to users/subscriptions/transactions/tasks/habits/notes — only canonicalUids', async () => {
  const db = injectDb({
    'users/uidSolo': { chatId: 42, isPro: true },
    'subscriptions/uidSolo': { plan: 'pro' },
    'tasks/t1': { userId: 'uidSolo' },
    'habits/h1': { userId: 'uidSolo' },
    'notes/n1': { userId: 'uidSolo' },
    'transactions/tx1': { userId: 'uidSolo', amount: 100 },
    'canonicalUids/tg_999': { uid: 'longGoneUid', telegramId: 999 },
  });
  try {
    const handler = require('../[action]');
    const protectedBefore = nonCanonicalEntries(db).map(([k, v]) => [k, JSON.stringify(v)]);
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    const protectedAfter = nonCanonicalEntries(db).map(([k, v]) => [k, JSON.stringify(v)]);
    assert.deepEqual(protectedAfter, protectedBefore, 'no user/subscription/transaction/task/habit/note doc changed');
    // Sanity: the migration DID do something (so this isn't a vacuous pass).
    assert.ok(res.body.repaired + res.body.canonicalized > 0);
  } finally { teardown(); }
});
