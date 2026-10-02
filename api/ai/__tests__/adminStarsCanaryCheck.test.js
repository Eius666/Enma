'use strict';

// Covers api/ai/[action].js's adminStarsCanaryCheck action — the self-service
// admin tool for diagnosing the Stars canary allowlist in production
// runtime (never trusts a client-supplied Telegram id, never returns the
// raw STARS_CANARY_TELEGRAM_IDS value or its list of ids).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = ['../[action]', '../../_lib/stars/canary', '../../_lib/stars/config', '../../_lib/verifyWebhookSig'];

const BOT_TOKEN = 'test-bot-token';
const ADMIN_KEY = 'test-admin-key';

function signInitData(params) {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}
function initDataFor(id) {
  return signInitData({ user: JSON.stringify({ id, first_name: 'Owner' }), auth_date: '1700000000' });
}

function injectEnv(env = {}) {
  const db = createMockDb({});
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown(envKeys = []) {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ADMIN_API_KEY;
  for (const k of envKeys) delete process.env[k];
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq({ body, headers = {} }) {
  return { method: 'POST', query: { action: 'adminStarsCanaryCheck' }, body, headers };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('adminStarsCanaryCheck: requires the admin key, independent of initData validity', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '798608938' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: initDataFor(798608938) }, headers: { 'x-admin-key': 'wrong' } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('adminStarsCanaryCheck: correctly-formatted canary value — full diagnostic for the matching user', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '798608938' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: initDataFor(798608938) }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.telegramUserResolved, true);
    assert.equal(res.body.telegramUserId, 798608938);
    assert.equal(res.body.envPresent, true);
    assert.equal(res.body.entriesCountRaw, 1);
    assert.equal(res.body.entriesCountValid, 1);
    assert.equal(res.body.allEntriesNumeric, true);
    assert.equal(res.body.globalEnabled, false);
    assert.equal(res.body.canaryMatched, true);
    assert.equal(res.body.isStarsEnabledForUserResult, true);
    assert.equal(res.body.starsPlansEquivalent.starsEnabled, true);
    // telegramUserId IS intentionally echoed back here — this is the
    // admin's own already-known caller identity (same id as the initData
    // they supplied), not a leak of the allowlist's contents. The response
    // never contains the raw env string or any OTHER id from the list.
    assert.ok(!('rawEnv' in res.body) && !('entries' in res.body) && !('ids' in res.body));
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('adminStarsCanaryCheck: malformed canary entry (CASE C) is flagged without revealing content', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '[798608938]' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: initDataFor(798608938) }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.envPresent, true);
    assert.equal(res.body.entriesCountRaw, 1);
    assert.equal(res.body.entriesCountValid, 0, 'bracketed value never parses as a plain integer');
    assert.equal(res.body.allEntriesNumeric, false);
    assert.equal(res.body.canaryMatched, false);
    assert.equal(res.body.isStarsEnabledForUserResult, false);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('adminStarsCanaryCheck: correctly-formatted but DIFFERENT number (CASE D)', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '111222333' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: initDataFor(798608938) }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.allEntriesNumeric, true);
    assert.equal(res.body.canaryMatched, false, 'a valid but different number must not match');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('adminStarsCanaryCheck: unset env entirely (CASE B)', async () => {
  const db = injectEnv({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: initDataFor(798608938) }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.envPresent, false);
    assert.equal(res.body.entriesCountRaw, 0);
    assert.equal(res.body.canaryMatched, false);
  } finally { teardown(); }
});

test('adminStarsCanaryCheck: tampered/invalid initData resolves no user and never matches', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '798608938' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: { initData: 'user=%7B%22id%22%3A798608938%7D&hash=deadbeef' }, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.telegramUserResolved, false);
    assert.equal(res.body.telegramUserId, null);
    assert.equal(res.body.canaryMatched, false);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('adminStarsCanaryCheck: missing initData is a clean 400, not a crash', async () => {
  const db = injectEnv({ STARS_CANARY_TELEGRAM_IDS: '798608938' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ body: {}, headers: { 'x-admin-key': ADMIN_KEY } });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});
