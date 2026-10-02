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

test('starsPlans: returns the canonical server-side price and starsEnabled flag', async () => {
  const db = injectMockDb({});
  try {
    const handler = require('../[action]');
    const req = mockReq({ action: 'starsPlans', method: 'GET' });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pro.month.starsPrice, 1000);
    assert.equal(res.body.starsEnabled, false, 'default-off until the owner flips the flag');
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

test('starsCreate: refuses even with valid initData while STARS_MINIAPP_ENABLED is false (backend enforces the flag too)', async () => {
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
    assert.equal(res.body.error, 'stars_miniapp_disabled');
  } finally { teardown(); }
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

test('starsSession: unknown session id is 404, known session reports its status', async () => {
  const db = injectMockDb({ 'stars_payment_sessions/abc': { status: 'paid' } });
  try {
    const handler = require('../[action]');

    const req1 = mockReq({ action: 'starsSession', method: 'GET', query: { sessionId: 'nope' } });
    const res1 = mockRes();
    await handler(req1, res1);
    assert.equal(res1.statusCode, 404);

    const req2 = mockReq({ action: 'starsSession', method: 'GET', query: { sessionId: 'abc' } });
    const res2 = mockRes();
    await handler(req2, res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.status, 'paid');
  } finally { teardown(); }
});
