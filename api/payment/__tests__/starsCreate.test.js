'use strict';

// Covers api/payment/[action].js's new Mini App Stars endpoints
// (Telegram Stars Audit §5/§6/§7/§25): starsPlans, starsCreate, starsSession.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULE_PATHS = [
  '../[action]',
  '../../_lib/referral/influencer',
  '../../_lib/referral/partners',
  '../../_lib/referral/codes',
  '../../_lib/promoCodes',
  '../../_lib/platega',
  '../../_lib/subscription/extend',
  '../../_lib/stars/config',
  '../../_lib/stars/sessions',
  '../../_lib/stars/canary',
  '../../_lib/verifyWebhookSig',
  '../../_lib/rateLimit',
];

const BOT_TOKEN = 'test-bot-token';

function signInitData(params) {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

function initDataFor(telegramUserId) {
  return signInitData({ user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }), auth_date: '1700000000' });
}

function injectMockDb(seed, env = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.STAR_PRICE_MONTHLY = '1000';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown(envKeys = []) {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.STAR_PRICE_MONTHLY;
  for (const k of envKeys) delete process.env[k];
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq({ action, method = 'POST', body, headers = {}, query = {} }) {
  return { method, query: { action, ...query }, body, headers };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('starsPlans: returns the canonical server-side price and starsEnabled=false with no auth at all', async () => {
  const db = injectMockDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsPlans', method: 'GET' });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pro.month.starsPrice, 1000);
    assert.equal(res.body.starsEnabled, false, 'default-off until the owner flips the flag or lists this user');
  } finally { teardown(); }
});

test('starsPlans: starsEnabled reflects THIS caller — true for a canary id, false for everyone else', async () => {
  const db = injectMockDb({}, { STARS_CANARY_TELEGRAM_IDS: '555' });
  try {
    const handler = require('../[action]');

    const reqCanary = mockReq({ action: 'starsPlans', method: 'GET', headers: { 'x-telegram-init-data': initDataFor(555) } });
    const resCanary = mockRes();
    await handler(reqCanary, resCanary);
    assert.equal(resCanary.body.starsEnabled, true);

    const reqOther = mockReq({ action: 'starsPlans', method: 'GET', headers: { 'x-telegram-init-data': initDataFor(999) } });
    const resOther = mockRes();
    await handler(reqOther, resOther);
    assert.equal(resOther.body.starsEnabled, false);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsPlans: debug block exposes safe diagnostics only, never the raw allowlist value', async () => {
  const db = injectMockDb({}, { STARS_CANARY_TELEGRAM_IDS: '798608938' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsPlans', method: 'GET', headers: { 'x-telegram-init-data': initDataFor(798608938) } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.debug.initDataReceived, true);
    assert.equal(res.body.debug.initDataValid, true);
    assert.equal(res.body.debug.telegramUserResolved, true);
    assert.equal(res.body.debug.globalEnabled, false);
    assert.equal(res.body.debug.envPresent, true);
    assert.equal(res.body.debug.entriesCountValid, 1);
    assert.equal(res.body.debug.allEntriesNumeric, true);
    assert.equal(res.body.debug.currentUserInCanary, true);

    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('798608938,'), 'no raw list serialization leaks through');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsPlans: debug block with no initData at all — honest "not received" rather than a false positive', async () => {
  const db = injectMockDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsPlans', method: 'GET', headers: {} });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.body.debug.initDataReceived, false);
    assert.equal(res.body.debug.telegramUserResolved, false);
    assert.equal(res.body.debug.currentUserInCanary, false);
  } finally { teardown(); }
});

test('starsCreate: rejects a request with no initData', async () => {
  const db = injectMockDb({}, { STARS_MINIAPP_ENABLED: 'true' });
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsCreate', body: { plan: 'pro', period: 'month' }, headers: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { teardown(['STARS_MINIAPP_ENABLED']); }
});

test('starsCreate: refuses a non-canary user while STARS_MINIAPP_ENABLED is false (backend enforces the allowlist too)', async () => {
  const db = injectMockDb({ 'users/u1': { chatId: 555 } });
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'STARS_NOT_ENABLED');
    assert.equal(db._keys('stars_payment_sessions/').length, 0, 'no session for a non-canary user, even server-side');
  } finally { teardown(); }
});

test('starsCreate: a CANARY-listed user succeeds even while STARS_MINIAPP_ENABLED is false', async () => {
  const db = injectMockDb(
    { 'users/u1': { chatId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '111,555,999' }
  );
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ json: async () => ({ ok: true, result: 'https://t.me/invoice/fake' }) });
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.sessionId);
  } finally { global.fetch = originalFetch; teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsCreate: a user NOT in the canary list is still refused even when the list is non-empty', async () => {
  const db = injectMockDb(
    { 'users/u1': { chatId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '111,222' }
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'STARS_NOT_ENABLED');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsCreate: malformed/non-numeric canary entries are ignored, never partially matched', async () => {
  const db = injectMockDb(
    { 'users/u1': { chatId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '55, owner, 5a5, ' } // "55" must NOT match 555
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsCreate: valid initData + registered user + valid plan creates a session and an invoice link', async () => {
  const db = injectMockDb({ 'users/u1': { chatId: 555 } }, { STARS_MINIAPP_ENABLED: 'true' });
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      assert.ok(String(url).includes('createInvoiceLink'));
      const sentBody = JSON.parse(opts.body);
      assert.equal(sentBody.currency, 'XTR');
      assert.equal(sentBody.provider_token, '');
      assert.equal(sentBody.prices[0].amount, 1000);
      assert.equal(sentBody.subscription_period, undefined, 'recurring must stay off by default');
      return { json: async () => ({ ok: true, result: 'https://t.me/invoice/fake' }) };
    };

    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.invoiceUrl, 'https://t.me/invoice/fake');
    assert.equal(res.body.starsAmount, 1000);
    assert.ok(res.body.sessionId);

    const session = db._get(`stars_payment_sessions/${res.body.sessionId}`);
    assert.equal(session.userId, 'u1');
    assert.equal(session.telegramUserId, 555);
  } finally { global.fetch = originalFetch; teardown(['STARS_MINIAPP_ENABLED']); }
});

test('starsCreate: invalid plan/period is rejected before any session is created', async () => {
  const db = injectMockDb({ 'users/u1': { chatId: 555 } }, { STARS_MINIAPP_ENABLED: 'true' });
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'premium', period: 'year' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_plan');
    assert.equal(db._keys('stars_payment_sessions/').length, 0);
  } finally { teardown(['STARS_MINIAPP_ENABLED']); }
});

test('starsCreate: a Telegram user with no Enma account is rejected', async () => {
  const db = injectMockDb({}, { STARS_MINIAPP_ENABLED: 'true' });
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsCreate', body: { plan: 'pro', period: 'month' },
      headers: { 'x-telegram-init-data': initDataFor(999) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'user_not_found');
  } finally { teardown(['STARS_MINIAPP_ENABLED']); }
});

test('starsSession: requires initData at all', async () => {
  const db = injectMockDb({ 'stars_payment_sessions/abc': { status: 'paid', telegramUserId: 555 } });
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsSession', method: 'GET', query: { sessionId: 'abc' }, headers: {} });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
  } finally { teardown(); }
});

test('starsSession: refuses a non-canary caller even for their own session, once the allowlist is non-empty', async () => {
  const db = injectMockDb(
    { 'stars_payment_sessions/abc': { status: 'created', telegramUserId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '111' }
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsSession', method: 'GET', query: { sessionId: 'abc' },
      headers: { 'x-telegram-init-data': initDataFor(555) },
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'STARS_NOT_ENABLED');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsSession: a canary caller cannot poll a DIFFERENT user\'s session', async () => {
  const db = injectMockDb(
    { 'stars_payment_sessions/abc': { status: 'created', telegramUserId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '555,999' }
  );
  try {
    const handler = require('../[action]');
    const req = mockReq({
      action: 'starsSession', method: 'GET', query: { sessionId: 'abc' },
      headers: { 'x-telegram-init-data': initDataFor(999) }, // different, also-canary user
    });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'forbidden');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('starsSession: unknown session id is 404, the owner\'s own known session reports its status', async () => {
  const db = injectMockDb(
    { 'stars_payment_sessions/abc': { status: 'paid', telegramUserId: 555 } },
    { STARS_CANARY_TELEGRAM_IDS: '555' }
  );
  try {
    const handler = require('../[action]');
    const headers = { 'x-telegram-init-data': initDataFor(555) };

    const req1 = mockReq({ action: 'starsSession', method: 'GET', query: { sessionId: 'nope' }, headers });
    const res1 = mockRes();
    await handler(req1, res1);
    assert.equal(res1.statusCode, 404);

    const req2 = mockReq({ action: 'starsSession', method: 'GET', query: { sessionId: 'abc' }, headers });
    const res2 = mockRes();
    await handler(req2, res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.status, 'paid');
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});
