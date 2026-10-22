'use strict';

// What Telegram sees from POST /api/telegram/webhook once the secret check has
// passed (signature and method handling: webhookSignature.test.js). Telegram
// redelivers any update that is not answered 2xx, so everything after the
// signature gate answers 200 — even when the update is ignored or its
// processing fails. In-process, in-memory Firestore, fake Telegram; no network.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const SECRET = 'webhook-contract-secret';
const SAVED = { ...process.env };
const realFetch = global.fetch;
const MODULES = ['../webhook', '../../_lib/verifyWebhookSig', '../../_lib/rateLimit', '../../_lib/envIsolation'];

function load(db = createMockDb({})) {
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  return require('../webhook');
}
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  global.fetch = realFetch;
  for (const m of ['../../_lib/firebaseAdmin', ...MODULES]) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
});

const fakeTelegram = () => {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  return calls;
};
const quiet = async (fn) => {
  const saved = ['log', 'warn', 'error'].map(k => [k, console[k]]);
  for (const [k] of saved) console[k] = () => {};
  try { return await fn(); } finally { for (const [k, f] of saved) console[k] = f; }
};
async function post(handler, body, ip = '198.51.100.20') {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
  await quiet(() => handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET, 'x-forwarded-for': ip }, body }, res));
  return res;
}
const env = (extra = {}) => Object.assign(process.env, { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_WEBHOOK_SECRET: SECRET, ...extra });
const CALLBACK = (fromId) => ({ callback_query: { id: 'cq1', data: 'noop', from: { id: fromId } } });

test('DEV: an update from a chat outside the allow-list is acknowledged and ignored', async () => {
  env({ ENMA_ENV: 'dev', DEV_ALLOWED_CHAT_IDS: '555' });
  const db = createMockDb({});
  const handler = load(db);
  const calls = fakeTelegram();
  const res = await post(handler, { message: { message_id: 1, chat: { id: 777 }, from: { id: 777 }, text: 'hi' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(calls.length, 0);
  assert.equal(db._store.size, 0);
});

test('DEV: an allowed chat is processed', async () => {
  env({ ENMA_ENV: 'dev', DEV_ALLOWED_CHAT_IDS: '555' });
  const handler = load();
  const calls = fakeTelegram();
  const res = await post(handler, CALLBACK(555));
  assert.equal(res.statusCode, 200);
  assert.ok(calls.some(c => c.url.endsWith('/answerCallbackQuery')));
});

test('over 100 updates a minute from one address: acknowledged without processing', async () => {
  env();
  const handler = load();
  const calls = fakeTelegram();
  for (let i = 0; i < 100; i++) assert.equal((await post(handler, CALLBACK(1), '198.51.100.30')).statusCode, 200);
  const before = calls.length;
  const res = await post(handler, CALLBACK(1), '198.51.100.30');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(calls.length, before, 'the throttled update is not processed');
});

test('an internal failure is still answered 200 (no redelivery loop) and the user is told', async () => {
  env();
  const failingDb = { collection: () => { throw new Error('storage down'); }, runTransaction: async () => { throw new Error('storage down'); }, batch: () => { throw new Error('storage down'); } };
  const handler = load(failingDb);
  const calls = fakeTelegram();
  const res = await post(handler, { message: { message_id: 1, chat: { id: 42 }, from: { id: 42, first_name: 'T' }, text: 'привет' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  const notice = calls.find(c => c.url.endsWith('/sendMessage') && c.body.chat_id === 42);
  assert.ok(notice, 'an error notice is sent to the chat');
});

test('unknown or empty updates are acknowledged', async () => {
  env();
  const handler = load();
  fakeTelegram();
  for (const body of [{}, { edited_message: { chat: { id: 1 } } }, { my_chat_member: {} }]) {
    const res = await post(handler, body);
    assert.equal(res.statusCode, 200, JSON.stringify(body));
    assert.deepEqual(res.body, { ok: true });
  }
});
