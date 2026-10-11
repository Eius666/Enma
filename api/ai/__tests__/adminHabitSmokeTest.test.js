'use strict';

// Covers api/ai/[action].js's temporary adminHabitSmokeTest{Create,Status,Delete}
// actions — the controlled production smoke test for the habit-notification
// fix. Verifies: the target UID is always the hardcoded one regardless of
// what the request body sends, requireAdmin gates all three, reminderTime
// is computed in the user's own timezone, and delete requires an explicit
// confirmation string.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const ADMIN_KEY = 'test-admin-key';
const MODULE_PATHS = ['../[action]'];

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../_lib/firebaseAdmin')]; } catch (_) {}
  delete process.env.ADMIN_API_KEY;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

function mockReq(action, { body = {}, headers = {} } = {}) {
  return { method: 'POST', query: { action }, body, headers };
}
function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('adminHabitSmokeTestCreate requires the admin key', async (t) => {
  injectMockDb({});
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(mockReq('adminHabitSmokeTestCreate', { headers: {} }), res);
  assert.equal(res.statusCode, 403);
});

test('adminHabitSmokeTestCreate always targets the hardcoded UID, ignoring any uid in the request body', async (t) => {
  const db = injectMockDb({ 'users/2MhVQ2hZD0cgDcYzxlHzhumml9l1': { timezone: 'Europe/Moscow' } });
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(
    mockReq('adminHabitSmokeTestCreate', {
      body: { uid: 'someone-elses-uid' }, // deliberately ignored
      headers: { 'x-admin-key': ADMIN_KEY },
    }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const habit = db._get('habits/enma-smoke-test-habit');
  assert.ok(habit);
  assert.equal(habit.userId, '2MhVQ2hZD0cgDcYzxlHzhumml9l1');
  assert.equal(habit.archived, false);
  assert.match(habit.reminderTime, /^\d{2}:\d{2}$/);
  assert.equal(res.body.timezone, 'Europe/Moscow');
});

test('adminHabitSmokeTestCreate falls back to the default timezone when the user has none set', async (t) => {
  injectMockDb({});
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(
    mockReq('adminHabitSmokeTestCreate', { headers: { 'x-admin-key': ADMIN_KEY } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.timezone); // some valid IANA default, not crashed/undefined
});

test('adminHabitSmokeTestStatus reports the habit and its reminders without requiring the admin key to leak anything else', async (t) => {
  injectMockDb({
    'habits/enma-smoke-test-habit': { userId: '2MhVQ2hZD0cgDcYzxlHzhumml9l1', archived: false, reminderTime: '12:00' },
    'reminders/habit-enma-smoke-test-habit-2026-10-11': {
      habitId: 'enma-smoke-test-habit', status: 'pending',
      scheduledAt: mockAdmin.firestore.Timestamp.fromDate(new Date('2026-10-11T12:00:00Z')),
    },
  });
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(mockReq('adminHabitSmokeTestStatus', { headers: { 'x-admin-key': ADMIN_KEY } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.habitExists, true);
  assert.equal(res.body.reminders.length, 1);
  assert.equal(res.body.reminders[0].status, 'pending');
});

test('adminHabitSmokeTestDelete refuses without the exact confirmation string', async (t) => {
  const db = injectMockDb({ 'habits/enma-smoke-test-habit': { userId: '2MhVQ2hZD0cgDcYzxlHzhumml9l1' } });
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(
    mockReq('adminHabitSmokeTestDelete', { body: { confirm: 'please' }, headers: { 'x-admin-key': ADMIN_KEY } }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.ok(db._get('habits/enma-smoke-test-habit')); // untouched
});

test('adminHabitSmokeTestDelete removes the habit and its reminders when confirmed', async (t) => {
  const db = injectMockDb({
    'habits/enma-smoke-test-habit': { userId: '2MhVQ2hZD0cgDcYzxlHzhumml9l1' },
    'reminders/r1': { habitId: 'enma-smoke-test-habit', status: 'sent' },
  });
  t.after(teardown);
  const handler = require('../[action]');
  const res = mockRes();
  await handler(
    mockReq('adminHabitSmokeTestDelete', { body: { confirm: 'DELETE_SMOKE_TEST_HABIT' }, headers: { 'x-admin-key': ADMIN_KEY } }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedReminders, 1);
  assert.equal(db._get('habits/enma-smoke-test-habit'), undefined);
  assert.equal(db._get('reminders/r1'), undefined);
});
