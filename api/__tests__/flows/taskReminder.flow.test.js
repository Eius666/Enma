'use strict';

// In-process flow test with stubs (NOT an end-to-end test against a real
// deployment): the real HTTP handlers of three routes share one in-memory
// Firestore, the clock is controlled, and Telegram is a fake that records
// what would have been sent.
//
//   1. POST /api/auth/telegram    a new Telegram user signs in from the Mini App
//   2. POST /api/ai/entityCreate  they create a task for 15:00 their time
//   3. GET  /api/telegram/cron    the external scheduler calls the cron
//      → the reminder reaches exactly that user's chat, exactly once.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const API = path.resolve(__dirname, '..', '..') + path.sep;
const FA = require.resolve('../../_lib/firebaseAdmin');
const BOT_TOKEN = '123456:FLOW-TEST-TOKEN';
const CRON_SECRET = 'flow-test-cron-secret';
const TG_ID = 4242;

const SAVED_ENV = { ...process.env };
const RealDate = Date;
const realFetch = global.fetch;
let nowMs;

function setClock(iso) { nowMs = RealDate.parse(iso); }
function installClock() {
  global.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
    static now() { return nowMs; }
  };
}

function freshHandlers(db) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(API) && !k.includes(`${path.sep}evals${path.sep}`)) delete require.cache[k];
  const admin = {
    ...mockAdmin,
    auth: () => ({
      createCustomToken: async (uid) => `custom-${uid}`,
      // The client exchanges the custom token for an ID token; here an ID token
      // is simply "id-<uid>".
      verifyIdToken: async (t) => { const m = /^id-(.+)$/.exec(t); if (!m) throw new Error('bad token'); return { uid: m[1] }; },
    }),
  };
  require.cache[FA] = { id: FA, filename: FA, loaded: true, exports: { db, admin } };
  return {
    auth: require('../../auth/telegram'),
    ai: require('../../ai/[action]'),
    cron: require('../../telegram/cron'),
  };
}

function initData(user, authDateSec) {
  const params = new URLSearchParams({ auth_date: String(authDateSec), query_id: 'AAflow', user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {} });
async function call(handler, req) {
  const r = res();
  const saved = ['log', 'warn', 'error'].map(k => [k, console[k]]);
  for (const [k] of saved) console[k] = () => {};
  try { await handler({ headers: {}, query: {}, ...req }, r); } finally { for (const [k, f] of saved) console[k] = f; }
  return r;
}

let sent;
beforeEach(() => {
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN, CRON_SECRET, ENMA_ENV: 'dev', DEV_ALLOWED_CHAT_IDS: String(TG_ID),
  });
  setClock('2026-10-22T09:00:00Z');
  installClock();
  sent = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.telegram.org/')) throw new TypeError(`unexpected network call: ${u}`);
    sent.push({ method: u.split('/').pop(), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
});
afterEach(() => {
  global.Date = RealDate;
  global.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  for (const k of Object.keys(require.cache)) if (k.startsWith(API) && !k.includes(`${path.sep}evals${path.sep}`)) delete require.cache[k];
  delete require.cache[FA];
});

async function signInAndCreateTask(db, h, { time = '15:00', date = '2026-10-22', timeZone = 'Europe/Moscow' } = {}) {
  const login = await call(h.auth, {
    method: 'POST',
    body: { initData: initData({ id: TG_ID, first_name: 'Flow', username: 'flow_user', language_code: 'ru' }, Math.floor(nowMs / 1000)) },
  });
  assert.equal(login.statusCode, 200, JSON.stringify(login.body));
  assert.equal(login.body.isNewUser, true);
  assert.equal(login.body.token, `custom-${login.body.uid}`);
  const uid = login.body.uid;
  assert.equal(db._get(`users/${uid}`).chatId, TG_ID, 'the server links the chat at sign-in');

  const created = await call(h.ai, {
    method: 'POST', query: { action: 'entityCreate' }, headers: { authorization: `Bearer id-${uid}` },
    body: { entityType: 'task', docId: 'flow-task-1', timeZone, data: { id: 'flow-task-1', title: 'Позвонить маме', date, time } },
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.body));
  return { uid, created };
}

const cronRun = (h) => call(h.cron, { method: 'GET', url: `/api/telegram/cron?secret=${CRON_SECRET}`, headers: { 'x-forwarded-for': '192.0.2.50' } });

test('new Telegram user → task at 15:00 Moscow → reminder delivered to their chat once, at the right time', async () => {
  const db = createMockDb({});
  const h = freshHandlers(db);
  const { uid, created } = await signInAndCreateTask(db, h);
  assert.equal(created.body.reminder, 'scheduled');

  const reminder = db._get('reminders/task-flow-task-1');
  assert.equal(reminder.userId, uid);
  assert.equal(reminder.chatId, TG_ID);
  assert.equal(reminder.scheduledAt.toDate().toISOString(), '2026-10-22T12:00:00.000Z');
  assert.equal(db._get('tasks/flow-task-1').userId, uid);

  // Before the time: the scheduler run sends nothing.
  setClock('2026-10-22T11:58:00Z');
  const early = await cronRun(h);
  assert.equal(early.statusCode, 200);
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 0);
  assert.equal(db._get('reminders/task-flow-task-1').status, 'pending');

  // Due: delivered to the owner's chat.
  setClock('2026-10-22T12:01:00Z');
  const due = await cronRun(h);
  assert.equal(due.statusCode, 200);
  assert.equal(due.body.reminders.sent, 1);
  const messages = sent.filter(s => s.method === 'sendMessage');
  assert.equal(messages.length, 1);
  assert.equal(String(messages[0].body.chat_id), String(TG_ID));
  assert.equal(messages[0].body.text, 'Задача: Позвонить маме');
  assert.equal(db._get('reminders/task-flow-task-1').status, 'sent');

  // The next scheduler run does not send it again.
  setClock('2026-10-22T12:06:00Z');
  await cronRun(h);
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 1);
});

test('the same task created twice (retried request) schedules one reminder and sends once', async () => {
  const db = createMockDb({});
  const h = freshHandlers(db);
  const { uid } = await signInAndCreateTask(db, h);
  const again = await call(h.ai, {
    method: 'POST', query: { action: 'entityCreate' }, headers: { authorization: `Bearer id-${uid}` },
    body: { entityType: 'task', docId: 'flow-task-1', timeZone: 'Europe/Moscow', data: { id: 'flow-task-1', title: 'Позвонить маме', date: '2026-10-22', time: '15:00' } },
  });
  assert.equal(again.body.reminder, 'already_scheduled');
  setClock('2026-10-22T12:01:00Z');
  await cronRun(h);
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 1);
});

test('a scheduler outage longer than the delivery window: the reminder is expired, never sent late or deleted', async () => {
  const db = createMockDb({});
  const h = freshHandlers(db);
  await signInAndCreateTask(db, h);
  setClock('2026-10-22T15:30:00Z'); // 3.5 h after the due time
  const run = await cronRun(h);
  assert.equal(run.body.reminders.expired, 1);
  assert.equal(sent.filter(s => s.method === 'sendMessage').length, 0);
  assert.equal(db._get('reminders/task-flow-task-1').status, 'expired');
});

test('a time already past when the task is created gets no reminder at all', async () => {
  const db = createMockDb({});
  const h = freshHandlers(db);
  const { created } = await signInAndCreateTask(db, h, { time: '10:00' }); // 07:00 UTC < 09:00 UTC now
  assert.equal(created.body.reminder, 'in_the_past');
  assert.equal(db._get('reminders/task-flow-task-1'), undefined);
});
