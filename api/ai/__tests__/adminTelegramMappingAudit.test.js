'use strict';

// Covers api/ai/[action].js's adminTelegramMappingAudit action — the
// temporary, admin-gated, read-only production audit for the
// TELEGRAM_PASSWORDLESS_AUTOAUTH effort. Never writes, never returns user
// ids/Telegram ids/emails/document contents — only aggregate counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = ['../[action]'];
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
  return { method, query: { action: 'adminTelegramMappingAudit' }, headers, body };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('adminTelegramMappingAudit: wrong x-admin-key -> 403 ADMIN_UNAUTHORIZED', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': 'wrong' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, code: 'ADMIN_UNAUTHORIZED' });
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: missing x-admin-key header -> 403 ADMIN_UNAUTHORIZED', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'ADMIN_UNAUTHORIZED');
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: GET -> 405 (router-level POST-only gate)', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ method: 'GET', headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: no body required — {} is a valid request', async () => {
  injectDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY }, body: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: valid key reaches the handler and returns only the allowed aggregate fields (top-level + nested breakdown)', async () => {
  const db = injectDb({
    'users/uidA': { chatId: 111 },
    'users/uidB': { chatId: '222' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const allowedTopLevelKeys = [
      'telegramLinkedUsers', 'uniquelyResolvableUsers', 'missingUidMapping',
      'duplicateTelegramMappings', 'telegramUsersWithoutResolvableAccount',
      'duplicateAnalysis', 'recoveryAnalysis', 'dryRun',
    ];
    assert.deepEqual(Object.keys(res.body).sort(), allowedTopLevelKeys.sort());
    for (const k of ['telegramLinkedUsers', 'uniquelyResolvableUsers', 'missingUidMapping', 'duplicateTelegramMappings', 'telegramUsersWithoutResolvableAccount']) {
      assert.equal(typeof res.body[k], 'number');
    }
    for (const v of Object.values(res.body.duplicateAnalysis)) assert.equal(typeof v, 'number');
    for (const v of Object.values(res.body.recoveryAnalysis)) assert.equal(typeof v, 'number');
    for (const v of Object.values(res.body.dryRun)) assert.equal(typeof v, 'number');
    assert.equal(res.body.telegramLinkedUsers, 2);
    assert.equal(res.body.uniquelyResolvableUsers, 2);
    assert.equal(res.body.duplicateTelegramMappings, 0);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: duplicateAnalysis attributes every conflict to multiplePlausibleActiveUids, never the two safe-pattern buckets', async () => {
  const db = injectDb({
    'users/uidOne': { chatId: 333 },
    'users/uidTwo': { chatId: '333' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.duplicateAnalysis.technicalDuplicateSameUid, 0);
    assert.equal(res.body.duplicateAnalysis.oneValidPlusStaleMapping, 0);
    assert.equal(res.body.duplicateAnalysis.multiplePlausibleActiveUids, 1);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: recoveryAnalysis splits orphaned telegramUsers mappings by whether another signal already resolves them', async () => {
  const db = injectDb({
    // tg_111: orphaned mapping, but a real chatId-linked account exists too — already fine.
    'users/uidReal': { chatId: 111 },
    'telegramUsers/tg_111': { firebaseUid: 'nonexistentA' },
    // tg_222: orphaned mapping, and NO other signal at all — true recovery_required.
    'telegramUsers/tg_222': { firebaseUid: 'nonexistentB' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.telegramUsersWithoutResolvableAccount, 2);
    assert.equal(res.body.recoveryAnalysis.orphanedMappingWithExistingSignal, 1);
    assert.equal(res.body.recoveryAnalysis.orphanedMappingWithNoOtherSignal, 1);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: dry-run preview never reports a non-zero count for unrecoverable, and never touches the store', async () => {
  const db = injectDb({
    'users/uidUnique': { chatId: 100 },
    'users/uidDupA':   { chatId: 200 },
    'users/uidDupB':   { chatId: '200' },
    'telegramUsers/tg_300': { firebaseUid: 'ghostUid' }, // orphaned, no other signal
    'canonicalUids/tg_400': { uid: 'anotherGhostUid' },  // stale cache entry
  });
  try {
    const handler = require('../[action]');
    const before = JSON.stringify([...db._store.entries()]);
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    const after = JSON.stringify([...db._store.entries()]);

    assert.equal(before, after, 'dry-run preview must never write');
    assert.equal(res.body.dryRun.wouldRepair, 1, 'the one stale canonicalUids entry');
    assert.equal(res.body.dryRun.wouldCanonicalize, 1, 'the one uncached-but-unique identity');
    assert.equal(res.body.dryRun.wouldSkipAmbiguous, 2, '1 duplicate + 1 no-signal orphaned mapping');
    assert.equal(res.body.dryRun.wouldSkipUnrecoverable, 0);
    assert.equal(res.body.dryRun.scanned, res.body.telegramLinkedUsers + 1 + 1);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: a Telegram id resolving to two accounts is counted as a conflict, not picked randomly', async () => {
  const db = injectDb({
    'users/uidOld':  { chatId: 333 },
    'users/uidNew':  { chatId: '333' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.telegramLinkedUsers, 1);
    assert.equal(res.body.duplicateTelegramMappings, 1);
    assert.equal(res.body.uniquelyResolvableUsers, 0);
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: an orphaned telegramUsers mapping is counted and does not crash the rest of the audit', async () => {
  const db = injectDb({
    'users/uidReal': { chatId: 444 },
    'telegramUsers/tg_555': { firebaseUid: 'doesNotExist' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.telegramUsersWithoutResolvableAccount, 1);
    assert.equal(res.body.telegramLinkedUsers, 1); // only the real chatId-linked user counts
  } finally { teardown(); }
});

test('adminTelegramMappingAudit: never performs any write', async () => {
  const db = injectDb({ 'users/uidA': { chatId: 666 } });
  try {
    const handler = require('../[action]');
    const before = JSON.stringify([...db._store.entries()]);
    const req = mockReq({ headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    const after = JSON.stringify([...db._store.entries()]);
    assert.equal(before, after, 'the Firestore store must be byte-identical before and after a read-only audit');
  } finally { teardown(); }
});
