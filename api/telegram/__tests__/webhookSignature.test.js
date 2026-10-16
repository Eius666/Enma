'use strict';

// SEC-12: webhook secret verification. Covers the pure verifier and the real
// HTTP handler (api/telegram/webhook.js) with a mock DB — no network, no
// production access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const SECRET = 'test-webhook-secret-0123456789abcdef';
const HDR = 'x-telegram-bot-api-secret-token';
const ENV_KEYS = ['TELEGRAM_WEBHOOK_SECRET', 'VERCEL_ENV', 'NODE_ENV', 'TELEGRAM_BOT_TOKEN'];

function saveEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}
function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
function loadVerifier() {
  delete require.cache[require.resolve('../../_lib/verifyWebhookSig')];
  return require('../../_lib/verifyWebhookSig').verifyWebhookSignature;
}

// ── verifier ────────────────────────────────────────────────────────────────

test('verifier: no secret + VERCEL_ENV set → 503 fail closed', (t) => {
  t.after(saveEnv());
  for (const vercelEnv of ['production', 'preview', 'development']) {
    setEnv({ VERCEL_ENV: vercelEnv });
    const r = loadVerifier()({ headers: {} });
    assert.equal(r.ok, false, vercelEnv);
    assert.equal(r.status, 503, vercelEnv);
  }
});

test('verifier: no secret + NODE_ENV=production → 503 even with a header', (t) => {
  t.after(saveEnv());
  setEnv({ NODE_ENV: 'production' });
  const r = loadVerifier()({ headers: { [HDR]: 'anything' } });
  assert.deepEqual([r.ok, r.status], [false, 503]);
});

test('verifier: no secret in bare local run → allowed', (t) => {
  t.after(saveEnv());
  setEnv({});
  const orig = console.warn; console.warn = () => {};
  t.after(() => { console.warn = orig; });
  assert.equal(loadVerifier()({ headers: {} }).ok, true);
});

test('verifier: secret set, header missing → 401', (t) => {
  t.after(saveEnv());
  setEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, VERCEL_ENV: 'production' });
  const r = loadVerifier()({ headers: {} });
  assert.deepEqual([r.ok, r.status], [false, 401]);
});

test('verifier: secret set, wrong / wrong-length / padded header → 401', (t) => {
  t.after(saveEnv());
  setEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, VERCEL_ENV: 'production' });
  const v = loadVerifier();
  for (const bad of ['x'.repeat(SECRET.length), 'short', SECRET + '\n', ' ' + SECRET]) {
    const r = v({ headers: { [HDR]: bad } });
    assert.deepEqual([r.ok, r.status], [false, 401], JSON.stringify(bad));
  }
});

test('verifier: secret set, correct header → ok', (t) => {
  t.after(saveEnv());
  setEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, VERCEL_ENV: 'production' });
  assert.equal(loadVerifier()({ headers: { [HDR]: SECRET } }).ok, true);
});

test('verifier: rejection reason never contains the secret', (t) => {
  t.after(saveEnv());
  setEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, VERCEL_ENV: 'production' });
  const r = loadVerifier()({ headers: { [HDR]: 'wrong' } });
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

// ── HTTP handler ────────────────────────────────────────────────────────────

const HANDLER_MODULES = ['../webhook', '../../_lib/verifyWebhookSig', '../../_lib/rateLimit'];

function loadHandler(seed = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const p of HANDLER_MODULES) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return { handler: require('../webhook'), db };
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  for (const p of HANDLER_MODULES) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}
function mockReq(headers, body) {
  return { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', ...headers }, body };
}
function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}
// A callback_query with an unknown data value takes the cheapest handler
// branch (answerCallbackQuery only). If the signature gate wrongly lets it
// through, fetch is called — which is exactly what these tests detect.
const CB_UPDATE = { callback_query: { id: 'cq1', data: 'noop', from: { id: 1 } } };

async function runHandler(t, { env, headers, body = CB_UPDATE }) {
  const restore = saveEnv();
  setEnv({ TELEGRAM_BOT_TOKEN: 'test-token', ...env });
  const { handler } = loadHandler();
  const origFetch = global.fetch;
  const origWarn = console.warn;
  const fetchCalls = [];
  const warns = [];
  global.fetch = async (...a) => { fetchCalls.push(a); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const res = mockRes();
    await handler(mockReq(headers, body), res);
    return { res, fetchCalls, warns };
  } finally {
    global.fetch = origFetch; console.warn = origWarn; teardown(); restore();
  }
}

test('handler: secret missing in production → 503, update NOT processed', async (t) => {
  const { res, fetchCalls } = await runHandler(t, { env: { VERCEL_ENV: 'production' }, headers: { [HDR]: SECRET } });
  assert.equal(res.statusCode, 503);
  assert.equal(fetchCalls.length, 0);
});

test('handler: missing header → 401, update NOT processed', async (t) => {
  const { res, fetchCalls } = await runHandler(t, { env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: {} });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false });
  assert.equal(fetchCalls.length, 0);
});

test('handler: wrong header → 401, update NOT processed, secret not logged', async (t) => {
  const { res, fetchCalls, warns } = await runHandler(t, {
    env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: { [HDR]: 'wrong' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(fetchCalls.length, 0);
  assert.ok(warns.length > 0);
  assert.ok(!warns.join('\n').includes(SECRET));
});

test('handler: correct header → update processed (callback answered, HTTP 200)', async (t) => {
  const { res, fetchCalls } = await runHandler(t, {
    env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: { [HDR]: SECRET },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(fetchCalls.some(([url]) => String(url).includes('answerCallbackQuery')));
});

test('handler: correct header → pre_checkout_query is answered', async (t) => {
  const body = { pre_checkout_query: { id: 'pcq1', from: { id: 1 }, currency: 'XTR', total_amount: 1, invoice_payload: 'garbage' } };
  const { res, fetchCalls } = await runHandler(t, {
    env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: { [HDR]: SECRET }, body,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(fetchCalls.some(([url]) => String(url).includes('answerPreCheckoutQuery')));
});

test('handler: correct header → successful_payment reaches Stars processing', async (t) => {
  const body = { message: { chat: { id: 777 }, successful_payment: { currency: 'XTR', total_amount: 1, invoice_payload: 'garbage', telegram_payment_charge_id: 'c1' } } };
  const { res } = await runHandler(t, {
    env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: { [HDR]: SECRET }, body,
  });
  // Unknown chatId → logged and acknowledged; the point is it is NOT rejected.
  assert.equal(res.statusCode, 200);
});

test('handler: correct header → plain message accepted (200)', async (t) => {
  const body = { message: { chat: { id: 1 } } };
  const { res } = await runHandler(t, {
    env: { VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET }, headers: { [HDR]: SECRET }, body,
  });
  assert.equal(res.statusCode, 200);
});

test('handler: non-POST still 405', async () => {
  const restore = saveEnv();
  setEnv({ VERCEL_ENV: 'production', TELEGRAM_WEBHOOK_SECRET: SECRET });
  const { handler } = loadHandler();
  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);
  teardown(); restore();
  assert.equal(res.statusCode, 405);
});
