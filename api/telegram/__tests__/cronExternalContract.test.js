'use strict';

// The contract an EXTERNAL scheduler relies on when it calls
// /api/telegram/cron: which methods are accepted, how the secret may be
// passed, what a successful answer looks like, and the rate limits. The
// handler is exercised in-process with an in-memory Firestore and a fake
// Telegram — no network, no real scheduler, nothing is sent anywhere.
//
// Authentication edge cases are covered in cronAuth.test.js; this file pins
// the caller-visible shape so that any change to it is deliberate.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const { Timestamp } = mockAdmin.firestore;
const SAVED = { ...process.env };
const realFetch = global.fetch;
const SECRET = 'external-scheduler-test-secret';

let ipSeq = 0;
const freshIp = () => `192.0.2.${(ipSeq++ % 250) + 1}`;

function load(seed = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  // The rate limiter keeps its window in module memory: a fresh copy per test.
  for (const m of ['../cron', '../../_lib/rateLimit']) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  return { db, cron: require('../cron') };
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  global.fetch = realFetch;
  for (const m of ['../../_lib/firebaseAdmin', '../cron', '../../_lib/rateLimit']) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
});

const res = () => ({
  statusCode: null, body: null,
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
});
const quiet = async (fn) => {
  const saved = ['log', 'warn', 'error'].map(k => [k, console[k]]);
  for (const [k] of saved) console[k] = () => {};
  try { return await fn(); } finally { for (const [k, f] of saved) console[k] = f; }
};
async function hit(cron, { method = 'GET', url = `/api/telegram/cron?secret=${SECRET}`, headers = {}, ip = freshIp() } = {}) {
  const r = res();
  await quiet(() => cron({ method, url, headers: { 'x-forwarded-for': ip, ...headers }, query: {} }, r));
  return r;
}
const fakeTelegram = () => {
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  return calls;
};
const dueReminder = () => ({
  'reminders/r1': { userId: 'u1', chatId: 555, title: 'T', telegramText: 'hi', status: 'pending', scheduledAt: Timestamp.fromMillis(Date.now() - 60_000), retryCount: 0 },
  'users/u1': { chatId: 555 },
});

// A non-production configuration: DEV isolation on, only the test chat allowed.
const nonProd = () => Object.assign(process.env, { ENMA_ENV: 'dev', TELEGRAM_BOT_TOKEN: '1:test', CRON_SECRET: SECRET, DEV_ALLOWED_CHAT_IDS: '555' });

const REMINDER_COUNTERS = ['scanned', 'sent', 'retried', 'failed', 'cancelled', 'expired', 'reclaimed', 'skipped', 'claimLost', 'deferred'];

test('GET with ?secret= (the form simple URL schedulers use) succeeds with a JSON summary', async () => {
  nonProd();
  const { db, cron } = load(dueReminder());
  const calls = fakeTelegram();
  const r = await hit(cron);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['automations', 'ok', 'reminders']);
  assert.equal(r.body.ok, true);
  assert.deepEqual(Object.keys(r.body.reminders).sort(), [...REMINDER_COUNTERS].sort());
  for (const k of REMINDER_COUNTERS) assert.equal(typeof r.body.reminders[k], 'number', k);
  assert.deepEqual(r.body.automations, { processed: 0, results: [] });
  assert.equal(r.body.reminders.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(db._get('reminders/r1').status, 'sent');
});

test('POST with Authorization: Bearer gives the same answer shape', async () => {
  nonProd();
  const { cron } = load(dueReminder());
  fakeTelegram();
  const r = await hit(cron, { method: 'POST', url: '/api/telegram/cron', headers: { authorization: `Bearer ${SECRET}` } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['automations', 'ok', 'reminders']);
});

test('an empty run is still a 200 with zero counters (the scheduler sees success)', async () => {
  nonProd();
  const { cron } = load({});
  const calls = fakeTelegram();
  const r = await hit(cron);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  for (const k of REMINDER_COUNTERS) assert.equal(r.body.reminders[k], 0, k);
  assert.equal(calls.length, 0);
});

test('other HTTP methods are 405 with a JSON body', async () => {
  nonProd();
  const { cron } = load({});
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    const r = await hit(cron, { method });
    assert.equal(r.statusCode, 405, method);
    assert.deepEqual(r.body, { ok: false, description: 'Method not allowed' });
  }
});

test('failure answers keep the { ok:false, description } shape', async () => {
  nonProd();
  const { cron } = load({});
  const unauthorized = await hit(cron, { url: '/api/telegram/cron?secret=wrong' });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.body, { ok: false, description: 'Unauthorized' });
});

test('rate limits per caller IP: 60 GET or 20 POST per minute, then 429', async () => {
  nonProd();
  const { cron } = load({});
  fakeTelegram();
  const ipGet = '198.51.100.7';
  for (let i = 0; i < 60; i++) assert.equal((await hit(cron, { ip: ipGet })).statusCode, 200, `GET #${i + 1}`);
  const limited = await hit(cron, { ip: ipGet });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.body, { ok: false, description: 'Too many requests' });

  const ipPost = '198.51.100.8';
  const post = { method: 'POST', url: '/api/telegram/cron', headers: { authorization: `Bearer ${SECRET}` }, ip: ipPost };
  for (let i = 0; i < 20; i++) assert.equal((await hit(cron, post)).statusCode, 200, `POST #${i + 1}`);
  assert.equal((await hit(cron, post)).statusCode, 429);
});

test('the answer never carries reminder texts, titles or chat ids', async () => {
  nonProd();
  const { cron } = load({
    'reminders/r1': { userId: 'u1', chatId: 555, title: 'SECRET-TITLE', telegramText: 'SECRET-TEXT', status: 'pending', scheduledAt: Timestamp.fromMillis(Date.now() - 60_000), retryCount: 0 },
    'users/u1': { chatId: 555 },
  });
  fakeTelegram();
  const blob = JSON.stringify((await hit(cron)).body);
  for (const needle of ['SECRET-TITLE', 'SECRET-TEXT', '555']) assert.ok(!blob.includes(needle), needle);
});
