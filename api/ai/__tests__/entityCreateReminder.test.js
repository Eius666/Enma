'use strict';

// POST /api/ai/entityCreate: when a task with a time is created, the reminder
// document is built from the zone the user typed the time in — never guessed.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../_lib/evals/fixtures');

const MODULES = ['../[action]', '../../_lib/entities/createEntity'];
function setup(seed, { createResult = { ok: true, id: 'task1' } } = {}) {
  const db = createMockDb(seed);
  const admin = { ...mockAdmin, auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }) };
  const fa = require.resolve('../../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin } };
  for (const m of MODULES) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
  const ce = require.resolve('../../_lib/entities/createEntity');
  require.cache[ce] = { id: ce, filename: ce, loaded: true, exports: {
    createEntityInFirestore: async () => createResult,
    getActivePlan: async () => 'free',
    ENTITY_COLLECTION_MAP: { task: 'tasks', note: 'notes', habit: 'habits', transaction: 'transactions' },
  } };
  try { delete require.cache[require.resolve('../[action]')]; } catch (_) {}
  return { db, handler: require('../[action]') };
}
afterEach(() => {
  for (const m of [...MODULES, '../../_lib/firebaseAdmin']) { try { delete require.cache[require.resolve(m)]; } catch (_) {} }
});

const res = () => ({ statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });
const post = async (handler, body) => {
  const r = res();
  const log = console.log; console.log = () => {};
  try { await handler({ method: 'POST', query: { action: 'entityCreate' }, headers: { authorization: 'Bearer x' }, body }, r); } finally { console.log = log; }
  return r;
};
const future = () => { const d = new Date(Date.now() + 2 * 24 * 3600 * 1000); return d.toISOString().slice(0, 10); };
const task = (over = {}) => ({ entityType: 'task', docId: 'task1', data: { id: 'task1', title: 'Call', date: future(), time: '20:00', ...over } });

test('client zone: the reminder is stored at the matching UTC instant, with that zone recorded', async () => {
  const { db, handler } = setup({ 'users/u1': { chatId: 555 } });
  const r = await post(handler, { ...task(), timeZone: 'Asia/Almaty' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.reminder, 'scheduled');
  const doc = db._get('reminders/task-task1');
  assert.equal(doc.status, 'pending');
  assert.equal(doc.timezone, 'Asia/Almaty');
  assert.equal(doc.userId, 'u1');
  assert.equal(doc.chatId, 555);
  assert.equal(doc.scheduledAt.toDate().toISOString(), `${future()}T15:00:00.000Z`);
  assert.equal(doc.taskId, 'task1');
});

test('no client zone: the user\'s stored zone is used; with neither, NO reminder is created (no silent Moscow default)', async () => {
  const stored = setup({ 'users/u1': { chatId: 555, timezone: 'Europe/Moscow' } });
  const r1 = await post(stored.handler, task());
  assert.equal(r1.body.reminder, 'scheduled');
  assert.equal(stored.db._get('reminders/task-task1').scheduledAt.toDate().toISOString(), `${future()}T17:00:00.000Z`);

  const unknown = setup({ 'users/u1': { chatId: 555 } });
  const r2 = await post(unknown.handler, task());
  assert.equal(r2.statusCode, 200, 'the task itself is still created');
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.reminder, 'timezone_unknown');
  assert.equal(unknown.db._get('reminders/task-task1'), undefined);
});

test('an invalid client zone is ignored in favour of the stored one', async () => {
  const { db, handler } = setup({ 'users/u1': { chatId: 555, timezone: 'Europe/Moscow' } });
  await post(handler, { ...task(), timeZone: 'Not/AZone' });
  assert.equal(db._get('reminders/task-task1').timezone, 'Europe/Moscow');
});

test('no Telegram link, a time in the past, or no time: the task is created, no reminder', async () => {
  const noLink = setup({ 'users/u1': { name: 'x' } });
  assert.equal((await post(noLink.handler, { ...task(), timeZone: 'UTC' })).body.reminder, 'no_telegram_link');
  assert.equal(noLink.db._get('reminders/task-task1'), undefined);

  const past = setup({ 'users/u1': { chatId: 555 } });
  assert.equal((await post(past.handler, { ...task({ date: '2020-01-01' }), timeZone: 'UTC' })).body.reminder, 'in_the_past');
  assert.equal(past.db._get('reminders/task-task1'), undefined);

  const noTime = setup({ 'users/u1': { chatId: 555 } });
  const r = await post(noTime.handler, { ...task({ time: null }), timeZone: 'UTC' });
  assert.equal(r.body.reminder, 'not_requested');
  assert.equal(noTime.db._get('reminders/task-task1'), undefined);
});

test('a repeated request cannot create or reset a second reminder (deterministic id, create-only)', async () => {
  const { db, handler } = setup({ 'users/u1': { chatId: 555 } });
  await post(handler, { ...task(), timeZone: 'UTC' });
  db._store.set('reminders/task-task1', { ...db._get('reminders/task-task1'), status: 'sent' });
  const again = await post(handler, { ...task(), timeZone: 'UTC' });
  assert.equal(again.body.reminder, 'already_scheduled');
  assert.equal(db._get('reminders/task-task1').status, 'sent', 'a delivered reminder is not re-armed');
  assert.equal(db._keys('reminders/').length, 1);
});

test('the chat id comes from the server-side user record, never from the request body', async () => {
  const { db, handler } = setup({ 'users/u1': { chatId: 555 } });
  await post(handler, { ...task(), timeZone: 'UTC', chatId: 999, data: { ...task().data, chatId: 999 } });
  assert.equal(db._get('reminders/task-task1').chatId, 555);
});

test('other entity types never create reminders', async () => {
  const { db, handler } = setup({ 'users/u1': { chatId: 555 } });
  const r = await post(handler, { entityType: 'note', docId: 'n1', data: { title: 'x', time: '10:00', date: future() }, timeZone: 'UTC' });
  assert.equal(r.body.reminder, 'not_requested');
  assert.equal(db._keys('reminders/').length, 0);
});

test('contract with the client: the task editor sends the device time zone next to the task', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'src', 'components', 'DayTaskEditor.tsx'), 'utf8');
  assert.match(src, /timeZone:\s*Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
});
