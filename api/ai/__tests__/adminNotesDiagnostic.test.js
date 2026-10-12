'use strict';

// Covers api/ai/[action].js's adminNotesDiagnostic action — ENMA notes-
// durability audit, PHASE 6. Read-only, single-uid (plus an optional
// second uid to compare), never returns note title/content, never scans
// beyond the uid(s) explicitly given.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATH = '../[action]';
const ADMIN_KEY = 'test-admin-key';

function injectEnv(seed = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try { delete require.cache[require.resolve(MODULE_PATH)]; } catch (_) {}
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.ADMIN_API_KEY;
  try { delete require.cache[require.resolve(MODULE_PATH)]; } catch (_) {}
}
function mockReq({ body, headers = {} }) {
  return { method: 'POST', query: { action: 'adminNotesDiagnostic' }, body, headers };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('adminNotesDiagnostic: requires the admin key', async () => {
  injectEnv({});
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': 'wrong' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: rejects with no uid (never a scan-everyone mode)', async () => {
  injectEnv({});
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: {}, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'uid_required');
  } finally { teardown(); }
});

test('adminNotesDiagnostic: rejects a non-string compareUid', async () => {
  injectEnv({});
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice', compareUid: 123 }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: counts top-level notes for the given uid only, never another uid\'s', async () => {
  injectEnv({
    'notes/n1': { userId: 'alice', title: 'a', content: 'x', type: 'text', rev: 2, updatedAt: { toDate: () => new Date() } },
    'notes/n2': { userId: 'alice', title: 'b', content: 'y', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
    'notes/n3': { userId: 'bob', title: 'c', content: 'z', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.primary.topLevelNoteCount, 2);
    // Never leaks bob's note id or content into alice's report.
    assert.ok(!JSON.stringify(res.body).includes('n3'));
    assert.ok(!JSON.stringify(res.body).includes('"z"'));
  } finally { teardown(); }
});

test('adminNotesDiagnostic: flags a legacy note missing rev/updatedAt without ever including its content', async () => {
  injectEnv({
    'notes/legacy1': { userId: 'alice', title: 'Old note', content: 'secret personal text', type: 'text' },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    const flagged = res.body.primary.flaggedNoteIds.find(f => f.id === 'legacy1');
    assert.ok(flagged, 'legacy doc should be flagged');
    assert.ok(flagged.issues.includes('rev_missing_legacy'));
    assert.ok(flagged.issues.includes('updatedAt_missing_or_wrong_type'));
    assert.equal(res.body.primary.missingUpdatedAtCount, 1);
    assert.equal(res.body.primary.missingRevCount, 1);
    assert.ok(!JSON.stringify(res.body).includes('secret personal text'));
  } finally { teardown(); }
});

test('adminNotesDiagnostic: surfaces the dead legacy users/{uid}/notes subcollection path separately, including docs missing userId', async () => {
  injectEnv({
    'users/alice/notes/old1': { title: 'from the old workspace subcollection model' },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.deepEqual(res.body.primary.legacySubcollectionNoteIds, ['old1']);
    assert.equal(res.body.primary.legacySubcollectionMissingUserId, 1);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: counts archived/deleted notes and breaks down by type/category', async () => {
  injectEnv({
    'notes/n1': { userId: 'alice', title: 'a', content: '', type: 'text', category: 'Work', rev: 1, updatedAt: { toDate: () => new Date() } },
    'notes/n2': { userId: 'alice', title: 'b', content: '', type: 'checklist', category: 'Work', archived: true, rev: 1, updatedAt: { toDate: () => new Date() } },
    'notes/n3': { userId: 'alice', title: 'c', content: '', type: 'text', category: 'General', isDeleted: true, rev: 1, updatedAt: { toDate: () => new Date() } },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.primary.archivedCount, 1);
    assert.equal(res.body.primary.deletedCount, 1);
    assert.deepEqual(res.body.primary.byType, { text: 2, checklist: 1 });
    assert.deepEqual(res.body.primary.byCategory, { Work: 2, General: 1 });
  } finally { teardown(); }
});

test('adminNotesDiagnostic: reports the real list-query (where+orderBy) count alongside the plain count', async () => {
  injectEnv({
    'notes/n1': { userId: 'alice', title: 'a', content: '', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.primary.listQueryError, null);
    assert.equal(res.body.primary.listQueryErrorCode, null);
    assert.equal(res.body.primary.listQueryErrorMessage, null);
    assert.equal(res.body.primary.listQueryCount, 1);
    assert.equal(res.body.primary.listQueryExcludesDocs, false);
    // NOTE: the shared test-fixture mock's orderBy() does not actually
    // drop documents missing the sort field (unlike real Firestore) — the
    // real exclusion behavior is verified against the Firestore EMULATOR
    // in api/_lib/entities/__tests__/createEntity.integration.test.js
    // instead, not asserted here.
  } finally { teardown(); }
});

test('adminNotesDiagnostic: flags a free-usage counter mismatch without guessing which side is wrong', async () => {
  injectEnv({
    'notes/n1': { userId: 'alice', title: 'a', content: 'x', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
    'users/alice/freeUsage/counters': { noteCount: 5 },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.primary.freeUsageNoteCounter, 5);
    assert.equal(res.body.primary.topLevelNoteCount, 1);
    assert.equal(res.body.primary.freeUsageCounterMismatch, true);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: with compareUid, reports both uids and whether they are the same account', async () => {
  injectEnv({
    'notes/n1': { userId: 'alice', title: 'a', content: 'x', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
    'notes/n2': { userId: 'bob', title: 'b', content: 'y', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
    'notes/n3': { userId: 'bob', title: 'c', content: 'z', type: 'text', rev: 1, updatedAt: { toDate: () => new Date() } },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice', compareUid: 'bob' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.primary.topLevelNoteCount, 1);
    assert.equal(res.body.compare.topLevelNoteCount, 2);
    assert.equal(res.body.compare.sameAccountAsPrimary, false);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: compareUid identical to uid is reported as the same account', async () => {
  injectEnv({});
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice', compareUid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.compare.sameAccountAsPrimary, true);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: a uid with zero notes returns zero, not an error', async () => {
  injectEnv({});
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'nobody' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.primary.topLevelNoteCount, 0);
    assert.deepEqual(res.body.primary.flaggedNoteIds, []);
    assert.deepEqual(res.body.primary.legacySubcollectionNoteIds, []);
  } finally { teardown(); }
});

test('adminNotesDiagnostic: reports whether the uid is linked to a Telegram identity, without echoing the Telegram id', async () => {
  injectEnv({
    'telegramUsers/798608938': { firebaseUid: 'alice' },
  });
  try {
    const handler = require(MODULE_PATH);
    const req = mockReq({ body: { uid: 'alice' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.body.primary.linkedToTelegram, true);
    assert.ok(!JSON.stringify(res.body).includes('798608938'));
  } finally { teardown(); }
});
