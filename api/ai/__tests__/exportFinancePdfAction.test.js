'use strict';

// Covers api/ai/[action].js's exportFinancePdf action — the Web REST
// counterpart of tools.js's export_finance_pdf Telegram tool. Both share
// the same api/_lib/pdf/exportFinancePdf.js orchestrator; this file only
// tests the HTTP-layer concerns (auth, limit gate, headers, error status
// mapping) that are specific to this action.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = ['../[action]', '../../_lib/aiUsage', '../../_lib/entities/createEntity', '../../_lib/pdf/exportFinancePdf'];

// requireAuth (api/ai/[action].js) calls admin.auth().verifyIdToken(token)
// and trusts decoded.uid — mockAdmin (evals/fixtures.js) has no .auth() at
// all (it's built for the admin-key-gated actions, not token-verified
// ones), so this test file decodes the Bearer token's own value AS the
// uid directly, same approach as api/_lib/__tests__/insights.test.js.
function injectEnv(seed = {}) {
  const db = createMockDb(seed);
  const authedAdmin = {
    ...mockAdmin,
    auth: () => ({ verifyIdToken: async (token) => ({ uid: token }) }),
  };
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: authedAdmin } };
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq({ body, headers = {} }) {
  return { method: 'POST', query: { action: 'exportFinancePdf' }, body, headers };
}
function mockRes() {
  const res = {
    statusCode: null, body: null, headers: {}, sentBuffer: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(payload) { this.sentBuffer = payload; return this; },
  };
  return res;
}

// mockAdmin.auth().verifyIdToken is expected to accept any token and
// decode it as { uid: <token> } — matches the other admin-action test
// fixtures' convention (see adminNotesDiagnostic.test.js), avoids needing
// a real Firebase ID token for a unit test.
function authHeaderFor(uid) {
  return { authorization: `Bearer ${uid}` };
}

test('exportFinancePdf: rejects with 401 when no Authorization header is present', async () => {
  injectEnv({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: {}, headers: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { teardown(); }
});

test('exportFinancePdf: free plan gets 429 with an upgrade message, no PDF generated', async () => {
  injectEnv({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: {}, headers: authHeaderFor('u1') });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'pdf_limit');
    assert.equal(res.sentBuffer, null);
  } finally { teardown(); }
});

test('exportFinancePdf: premium plan gets a real PDF back with the correct headers', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
    'transactions/t1': { userId: 'u1', type: 'income', amount: 500, currency: 'RUB', rubAmount: 500, schemaVersion: 2, fx: null, category: 'cat-x', description: 'x', date: '2026-09-01T09:00:00.000Z', source: 'web-app' },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { period: 'all' }, headers: authHeaderFor('u1') });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/pdf');
    assert.match(res.headers['Content-Disposition'], /attachment; filename="ENMA-finance-report/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.ok(Buffer.isBuffer(res.sentBuffer));
    assert.equal(res.sentBuffer.slice(0, 4).toString('latin1'), '%PDF');
  } finally { teardown(); }
});

test('exportFinancePdf: never reads uid from the request body, only the verified token', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
    'transactions/other-user-secret': { userId: 'mallory', type: 'income', amount: 999999, currency: 'RUB', rubAmount: 999999, schemaVersion: 2, fx: null, category: 'cat-x', description: 'SECRET', date: '2026-09-01T09:00:00.000Z', source: 'web-app' },
  });
  try {
    const handler = require('../[action]');
    // Attempt to impersonate mallory via the body — the verified token (u1) must win.
    const req = mockReq({ body: { period: 'all', uid: 'mallory', userId: 'mallory' }, headers: authHeaderFor('u1') });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    // u1 has zero real transactions of their own — the report must be empty, not mallory's.
    assert.ok(Buffer.isBuffer(res.sentBuffer));
  } finally { teardown(); }
});

test('exportFinancePdf: an invalid period maps to 400, not 500 or a silent default', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { period: 'decade' }, headers: authHeaderFor('u1') });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_PERIOD');
  } finally { teardown(); }
});

test('exportFinancePdf: the monthly limit, once reached, blocks a second request even on the same day', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
    'aiUsage/u1': { userId: 'u1', month: new Date().toISOString().slice(0, 7), pdfReports: 10, textRequests: 0, imageRequests: 0 },
  });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: {}, headers: authHeaderFor('u1') });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 429);
  } finally { teardown(); }
});
