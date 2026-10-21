'use strict';

// Authentication and DEV behaviour of POST /api/telegram/cron, through the real
// handler with an in-memory Firestore and a fake fetch (no network).

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const { Timestamp } = mockAdmin.firestore;
const SAVED = { ...process.env };
const realFetch = global.fetch;

function load(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  try { delete require.cache[require.resolve('../cron')]; } catch (_) {}
  return { db, cron: require('../cron') };
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  global.fetch = realFetch;
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  try { delete require.cache[require.resolve('../cron')]; } catch (_) {}
});

const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });
const req = (headers = {}, url = '/api/telegram/cron') => ({ method: 'POST', headers, url });
const due = (over = {}) => ({ userId: 'u1', chatId: 555, title: 'T', telegramText: 'hello', status: 'pending', scheduledAt: Timestamp.fromMillis(Date.now() - 60_000), retryCount: 0, ...over });
const seed = (over) => ({ 'reminders/r1': due(over), 'users/u1': { chatId: 555 } });
const fakeTelegram = () => { const calls = []; global.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }; return calls; };

function dev(extra = {}) {
  Object.assign(process.env, { ENMA_ENV: 'dev', TELEGRAM_BOT_TOKEN: '1:test', CRON_SECRET: 'a-long-test-secret', DEV_ALLOWED_CHAT_IDS: '555', ...extra });
}

test('DEV without CRON_SECRET fails closed: 503 and nothing is processed', async () => {
  dev(); delete process.env.CRON_SECRET;
  const { db, cron } = load(seed());
  const calls = fakeTelegram();
  const r = res(); await cron(req(), r);
  assert.equal(r.statusCode, 503);
  assert.equal(calls.length, 0);
  assert.equal(db._get('reminders/r1').status, 'pending');
});

test('wrong, missing or look-alike credentials are refused with 401 and nothing is sent', async () => {
  dev();
  for (const [headers, url] of [
    [{}, undefined],
    [{ authorization: 'Bearer nope' }, undefined],
    [{ authorization: 'Bearer a-long-test-secre' }, undefined],
    [{ authorization: 'a-long-test-secret' }, undefined],
    [{}, '/api/telegram/cron?secret=wrong'],
    // The User-Agent is client-controlled and must not unlock the endpoint.
    [{ 'user-agent': 'vercel-cron/1.0' }, undefined],
  ]) {
    const { db, cron } = load(seed());
    const calls = fakeTelegram();
    const r = res(); await cron(req(headers, url), r);
    assert.equal(r.statusCode, 401, JSON.stringify(headers) + url);
    assert.equal(calls.length, 0);
    assert.equal(db._get('reminders/r1').status, 'pending');
  }
});

test('a correct Bearer secret runs the batch; the answer carries counters only (no chat ids, texts or titles)', async () => {
  dev();
  const { db, cron } = load(seed({ title: 'PRIVATE-TITLE', telegramText: 'PRIVATE-TEXT' }));
  const calls = fakeTelegram();
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.reminders.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(db._get('reminders/r1').status, 'sent');
  const blob = JSON.stringify(r.body);
  for (const needle of ['PRIVATE-TITLE', 'PRIVATE-TEXT', '555']) assert.ok(!blob.includes(needle), needle);
});

test('the secret may also arrive as ?secret= (kept for compatibility)', async () => {
  dev();
  const { cron } = load(seed());
  fakeTelegram();
  const r = res(); await cron(req({}, '/api/telegram/cron?secret=a-long-test-secret'), r);
  assert.equal(r.statusCode, 200);
});

test('DEV allow-list is enforced end to end: a chat that is not listed gets nothing', async () => {
  dev({ DEV_ALLOWED_CHAT_IDS: '777' });
  const { db, cron } = load(seed());
  const calls = fakeTelegram();
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(calls.length, 0);
  assert.equal(db._get('reminders/r1').status, 'failed');
  assert.equal(db._get('reminders/r1').lastError, 'recipient_not_allowed');
});

test('a mismatching owner/chat is refused through the handler too', async () => {
  dev();
  const { db, cron } = load({ 'reminders/r1': due({ chatId: 555 }), 'users/u1': { chatId: 777 } });
  const calls = fakeTelegram();
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(calls.length, 0);
  assert.equal(db._get('reminders/r1').lastError, 'recipient_mismatch');
});

test('a Telegram outage does not leave reminders stuck in "sending" and does not turn the run into a 500', async () => {
  dev();
  const { db, cron } = load(seed());
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(r.statusCode, 200);
  const doc = db._get('reminders/r1');
  assert.equal(doc.status, 'pending');
  assert.equal(doc.retryCount, 1);
  assert.notEqual(doc.status, 'sending');
});

test('old unsent reminders are never deleted by a run (they are marked expired)', async () => {
  dev();
  const { db, cron } = load(seed({ scheduledAt: Timestamp.fromMillis(Date.now() - 3 * 24 * 3600 * 1000) }));
  const calls = fakeTelegram();
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(calls.length, 0);
  assert.equal(db._get('reminders/r1').status, 'expired');
  assert.equal(r.body.reminders.expired, 1);
  assert.equal(r.body.staleRemindersDeleted, undefined);
});

test('missing bot token is a 500 before anything is touched', async () => {
  dev(); delete process.env.TELEGRAM_BOT_TOKEN;
  const { db, cron } = load(seed());
  const r = res(); await cron(req({ authorization: 'Bearer a-long-test-secret' }), r);
  assert.equal(r.statusCode, 500);
  assert.equal(db._get('reminders/r1').status, 'pending');
});
