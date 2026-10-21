'use strict';

// Focused regression coverage for the habit-staleness re-check added to
// api/telegram/cron.js (PHASE 2, scenario E / PHASE 4 of the ENMA
// habit-notification pre-deploy review): this endpoint is confirmed LIVE in
// production (.github/workflows/telegram-cron.yml pings it every 5 min) and
// races the Firebase sendDueReminders function for the same `reminders`
// documents, so it needs the same "don't send a knowably stale habit
// reminder" protection, independently implemented in api/_lib/habits/
// habitSchedule.js. Pre-existing cron.js behavior (task reminders,
// automations, stale cleanup) is left untouched and is not re-tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  try { delete require.cache[require.resolve('../cron')]; } catch (_) {}
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  try { delete require.cache[require.resolve('../cron')]; } catch (_) {}
}

function mockReq() {
  return { method: 'POST', headers: { 'user-agent': 'vercel-cron/1.0' }, url: '/api/telegram/cron' };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const Timestamp = mockAdmin.firestore.Timestamp;

test('a habit_reminder for a still-active, still-due habit is sent normally', async (t) => {
  const pastDue = Timestamp.fromDate(new Date(Date.now() - 60_000));
  const db = injectMockDb({
    'reminders/r1': {
      type: 'habit_reminder', habitId: 'h1', userId: 'u1', chatId: 555,
      title: 'Water', telegramText: '🌱 Привычка: «Water» — не забудь отметить сегодня!',
      status: 'pending', scheduledAt: pastDue,
    },
    'habits/h1': { userId: 'u1', title: 'Water', repeatType: 'daily', reminderTime: '09:00', archived: false },
    'users/u1': { timezone: 'Europe/Moscow', chatId: 555 }, // owner's chat id: the recipient must match it
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  t.after(() => { global.fetch = originalFetch; teardown(); });

  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.CRON_SECRET;
  const cron = require('../cron');
  const res = mockRes();
  await cron(mockReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls, 1);
  assert.equal(db._get('reminders/r1').status, 'sent');
});

test('a habit_reminder for an ARCHIVED habit is cancelled instead of sent', async (t) => {
  const pastDue = Timestamp.fromDate(new Date(Date.now() - 60_000));
  const db = injectMockDb({
    'reminders/r1': {
      type: 'habit_reminder', habitId: 'h1', userId: 'u1', chatId: 555,
      title: 'Water', telegramText: 'x', status: 'pending', scheduledAt: pastDue,
    },
    'habits/h1': { userId: 'u1', title: 'Water', repeatType: 'daily', reminderTime: '09:00', archived: true },
    'users/u1': { timezone: 'Europe/Moscow', chatId: 555 }, // owner's chat id: the recipient must match it
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  t.after(() => { global.fetch = originalFetch; teardown(); });

  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.CRON_SECRET;
  const cron = require('../cron');
  const res = mockRes();
  await cron(mockReq(), res);

  assert.equal(fetchCalls, 0); // Telegram was never called
  assert.equal(db._get('reminders/r1').status, 'cancelled');
});

test('a habit_reminder for a DELETED habit is cancelled instead of sent', async (t) => {
  const pastDue = Timestamp.fromDate(new Date(Date.now() - 60_000));
  const db = injectMockDb({
    'reminders/r1': {
      type: 'habit_reminder', habitId: 'h-deleted', userId: 'u1', chatId: 555,
      title: 'Water', telegramText: 'x', status: 'pending', scheduledAt: pastDue,
    },
    'users/u1': { timezone: 'Europe/Moscow', chatId: 555 }, // owner's chat id: the recipient must match it
    // no habits/h-deleted doc at all
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  t.after(() => { global.fetch = originalFetch; teardown(); });

  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.CRON_SECRET;
  const cron = require('../cron');
  const res = mockRes();
  await cron(mockReq(), res);

  assert.equal(fetchCalls, 0);
  assert.equal(db._get('reminders/r1').status, 'cancelled');
});

test('a non-habit reminder (task/manual) is unaffected by the habit staleness check', async (t) => {
  const pastDue = Timestamp.fromDate(new Date(Date.now() - 60_000));
  const db = injectMockDb({
    'reminders/r1': {
      userId: 'u1', chatId: 555, title: 'Pay rent',
      telegramText: '⏰ Напоминание: Pay rent', status: 'pending', scheduledAt: pastDue,
    },
    'users/u1': { chatId: 555 }, // owner's chat id: the recipient must match it
  });

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  t.after(() => { global.fetch = originalFetch; teardown(); });

  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.CRON_SECRET;
  const cron = require('../cron');
  const res = mockRes();
  await cron(mockReq(), res);

  assert.equal(fetchCalls, 1);
  assert.equal(db._get('reminders/r1').status, 'sent');
});
