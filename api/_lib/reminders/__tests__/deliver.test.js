'use strict';

// processDueReminders on the in-memory Firestore mock. All Telegram calls are
// scripted fakes — nothing here can reach the network. (True concurrency is
// covered against the real emulator in deliver.integration.test.js; the mock
// applies transaction writes after the callback and cannot model contention.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../evals/fixtures');
const { EnvIsolationError } = require('../../envIsolation');
const D = require('../deliver');

const { Timestamp, FieldValue } = mockAdmin.firestore;
const T0 = Date.parse('2026-10-21T12:00:00Z');
const ts = (ms) => Timestamp.fromMillis(ms);
const min = (n) => n * 60 * 1000;

function setup(seed, { send, allowed = () => true, shouldSkip, clock = { t: T0 } } = {}) {
  const db = createMockDb(seed);
  const logs = [];
  const calls = [];
  const deps = {
    db,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    fromMillis: (ms) => Timestamp.fromMillis(ms),
    send: async (chatId, text) => {
      calls.push({ chatId, text });
      return send ? send(chatId, text, calls.length) : { ok: true, status: 200, payload: { ok: true } };
    },
    isRecipientAllowed: allowed,
    shouldSkip,
    now: () => clock.t,
    log: (event, fields) => logs.push({ event, ...fields }),
  };
  return { db, deps, logs, calls, clock, run: () => D.processDueReminders(deps) };
}
const due = (over = {}) => ({
  userId: 'u1', chatId: 555, title: 'Pay rent', telegramText: 'Задача: Pay rent',
  status: 'pending', scheduledAt: ts(T0 - min(1)), retryCount: 0, ...over,
});
const USER = { 'users/u1': { chatId: 555 } };

test('happy path: pending -> sent, exactly one Telegram call to the right chat with the stored text', async () => {
  const s = setup({ 'reminders/r1': due(), ...USER });
  const stats = await s.run();
  assert.equal(stats.sent, 1);
  assert.deepEqual(s.calls, [{ chatId: '555', text: 'Задача: Pay rent' }]);
  const doc = s.db._get('reminders/r1');
  assert.equal(doc.status, 'sent');
  assert.equal(doc.claimId, null);
  assert.equal(doc.leaseUntil, null);
  assert.ok(doc.notifiedAt && doc.sentAt);
});

test('a reminder that is not due yet is left alone; a repeat run does not resend a sent one', async () => {
  const s = setup({ 'reminders/future': due({ scheduledAt: ts(T0 + min(30)) }), 'reminders/r1': due(), ...USER });
  await s.run();
  await s.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.db._get('reminders/future').status, 'pending');
});

test('an error on one reminder does not stop the others, and the failed one is retried with backoff (not stuck in sending)', async () => {
  const s = setup({
    'reminders/a': due({ scheduledAt: ts(T0 - min(3)) }),
    'reminders/b': due({ scheduledAt: ts(T0 - min(2)) }),
    'reminders/c': due({ scheduledAt: ts(T0 - min(1)) }),
    ...USER,
  }, { send: (chat, text, n) => { if (n === 2) throw new TypeError('fetch failed'); return { ok: true, status: 200, payload: { ok: true } }; } });
  const stats = await s.run();
  assert.equal(stats.sent, 2);
  assert.equal(stats.retried, 1);
  const b = s.db._get('reminders/b');
  assert.equal(b.status, 'pending');
  assert.equal(b.retryCount, 1);
  assert.equal(b.lastError, 'send_network');
  assert.equal(b.scheduledAt.toMillis(), T0 + 60_000);
  assert.equal(s.db._get('reminders/a').status, 'sent');
  assert.equal(s.db._get('reminders/c').status, 'sent');
});

test('Telegram 400 / 403 / 404 are permanent: failed with a diagnosable code, no retry', async () => {
  for (const status of [400, 403, 404]) {
    const s = setup({ 'reminders/r1': due(), ...USER }, { send: () => ({ ok: false, status, payload: { ok: false, description: 'Forbidden: bot was blocked by the user' } }) });
    const stats = await s.run();
    assert.equal(stats.failed, 1, String(status));
    const doc = s.db._get('reminders/r1');
    assert.equal(doc.status, 'failed');
    assert.equal(doc.lastError, `telegram_${status}`);
    await s.run();
    assert.equal(s.calls.length, 1, 'a failed reminder is never retried');
  }
});

test('429 honours retry_after (never earlier than the backoff) and 5xx uses exponential backoff; attempts are bounded', async () => {
  const s = setup({ 'reminders/r1': due(), ...USER }, { send: () => ({ ok: false, status: 429, payload: { parameters: { retry_after: 300 } } }) });
  await s.run();
  assert.equal(s.db._get('reminders/r1').scheduledAt.toMillis(), T0 + 300_000);

  const s2 = setup({ 'reminders/r1': due(), ...USER }, { send: () => ({ ok: false, status: 502, payload: {} }) });
  const delays = [];
  for (let i = 0; i < D.MAX_ATTEMPTS; i++) {
    await s2.run();
    const doc = s2.db._get('reminders/r1');
    if (doc.status !== 'pending') break;
    delays.push(doc.scheduledAt.toMillis() - s2.clock.t);
    s2.clock.t = doc.scheduledAt.toMillis() + 1; // time passes until it is due again
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000]);
  const final = s2.db._get('reminders/r1');
  assert.equal(final.status, 'failed');
  assert.equal(final.lastError, 'retries_exhausted');
  assert.equal(s2.calls.length, D.MAX_ATTEMPTS);
});

test('401 (bot token rejected) retries later and stops the batch instead of failing every reminder', async () => {
  const s = setup({ 'reminders/a': due({ scheduledAt: ts(T0 - min(3)) }), 'reminders/b': due({ scheduledAt: ts(T0 - min(2)) }), ...USER },
    { send: () => ({ ok: false, status: 401, payload: { ok: false } }) });
  await s.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.db._get('reminders/a').status, 'pending');
  assert.equal(s.db._get('reminders/b').status, 'pending', 'untouched');
});

test('lease: a live claim is respected; an expired one is re-queued (not sent in the same run, not stuck)', async () => {
  const s = setup({
    'reminders/live': due({ status: 'sending', claimId: 'x', leaseUntil: ts(T0 + min(2)) }),
    'reminders/dead': due({ status: 'sending', claimId: 'y', leaseUntil: ts(T0 - min(1)), retryCount: 1 }),
    'reminders/legacy': due({ status: 'sending', updatedAt: ts(T0 - min(30)) }), // stuck by older code: no lease field
    ...USER,
  });
  const stats = await s.run();
  assert.equal(stats.reclaimed, 2);
  assert.equal(s.db._get('reminders/live').status, 'sending');
  const dead = s.db._get('reminders/dead');
  assert.equal(dead.status, 'pending');
  assert.equal(dead.retryCount, 2);
  assert.equal(dead.lastError, 'lease_expired');
  assert.ok(dead.scheduledAt.toMillis() > T0);
  assert.equal(s.db._get('reminders/legacy').status, 'pending');
  assert.equal(s.calls.length, 0);
});

test('lease: an expired claim on the last allowed attempt becomes failed, never an endless loop', async () => {
  const s = setup({ 'reminders/r1': due({ status: 'sending', claimId: 'y', leaseUntil: ts(T0 - 1), retryCount: D.MAX_ATTEMPTS - 1 }), ...USER });
  await s.run();
  const doc = s.db._get('reminders/r1');
  assert.equal(doc.status, 'failed');
  assert.equal(doc.lastError, 'lease_expired_retries_exhausted');
});

test('a worker that lost its claim cannot overwrite the new owner\'s outcome', async () => {
  const s = setup({ 'reminders/r1': due(), ...USER }, {
    send: () => {
      // While "sending", another worker re-claims the document.
      s.db._store.set('reminders/r1', { ...s.db._get('reminders/r1'), claimId: 'someone-else' });
      return { ok: true, status: 200, payload: { ok: true } };
    },
  });
  const stats = await s.run();
  assert.equal(stats.claimLost, 1);
  assert.equal(s.db._get('reminders/r1').status, 'sending');
  assert.equal(s.db._get('reminders/r1').claimId, 'someone-else');
});

test('recipient outside the DEV allow-list: nothing is sent, the reminder is failed with a clear code', async () => {
  const s = setup({ 'reminders/r1': due(), ...USER }, { allowed: () => false });
  const stats = await s.run();
  assert.equal(s.calls.length, 0);
  assert.equal(stats.failed, 1);
  assert.equal(s.db._get('reminders/r1').lastError, 'recipient_not_allowed');
});

test('the env guard refusing at transport level is permanent, not an endless retry', async () => {
  const s = setup({ 'reminders/r1': due(), ...USER }, { send: () => { throw new EnvIsolationError('DEV_EGRESS_CHAT_NOT_ALLOWED'); } });
  await s.run();
  const doc = s.db._get('reminders/r1');
  assert.equal(doc.status, 'failed');
  assert.equal(doc.lastError, 'recipient_blocked_by_env_guard');
});

test('owner check: a chat id that is not the owner\'s is never messaged (client-written field is not trusted)', async () => {
  const cases = {
    'different chat id': { 'reminders/r1': due({ chatId: 999 }), ...USER },
    'owner has no chat id': { 'reminders/r1': due(), 'users/u1': { name: 'x' } },
    'owner document missing': { 'reminders/r1': due() },
  };
  for (const [name, seed] of Object.entries(cases)) {
    const s = setup(seed);
    await s.run();
    assert.equal(s.calls.length, 0, name);
    assert.equal(s.db._get('reminders/r1').status, 'failed', name);
    assert.equal(s.db._get('reminders/r1').lastError, 'recipient_mismatch', name);
  }
  const noOwner = setup({ 'reminders/r1': due({ userId: undefined }), ...USER });
  await noOwner.run();
  assert.equal(noOwner.calls.length, 0);
  assert.equal(noOwner.db._get('reminders/r1').lastError, 'no_owner');
  for (const chatId of ['abc', '1; DROP', '', null, '@channel']) {
    const bad = setup({ 'reminders/r1': due({ chatId }), 'users/u1': { chatId } });
    await bad.run();
    assert.equal(bad.calls.length, 0, String(chatId));
    assert.equal(bad.db._get('reminders/r1').lastError, 'invalid_chat_id');
  }
});

test('owner check also accepts the legacy telegramId field and string/number chat id forms', async () => {
  const s = setup({ 'reminders/r1': due({ chatId: '555' }), 'users/u1': { telegramId: 555 } });
  await s.run();
  assert.equal(s.db._get('reminders/r1').status, 'sent');
});

test('old pending reminders are NOT sent after the scheduler is switched on: they are marked expired, never deleted', async () => {
  const old = { scheduledAt: ts(T0 - D.MAX_LATE_MS - min(1)) };
  const s = setup({ 'reminders/old1': due(old), 'reminders/old2': due({ scheduledAt: ts(T0 - 30 * 24 * 3600 * 1000) }), 'reminders/fresh': due(), ...USER });
  const stats = await s.run();
  assert.equal(stats.expired, 2);
  assert.equal(s.calls.length, 1, 'only the fresh reminder is delivered');
  for (const id of ['old1', 'old2']) {
    const doc = s.db._get(`reminders/${id}`);
    assert.ok(doc, 'document still exists');
    assert.equal(doc.status, 'expired');
    assert.equal(doc.lastError, 'missed_window');
  }
});

test('documents without a usable scheduledAt are skipped, not sent', async () => {
  const s = setup({ 'reminders/r1': due({ scheduledAt: undefined }), 'reminders/r2': due({ scheduledAt: 'garbage' }), ...USER });
  const stats = await s.run();
  assert.equal(stats.skipped, 2);
  assert.equal(s.calls.length, 0);
});

test('ISO-string scheduledAt written by older code is understood', async () => {
  const s = setup({ 'reminders/r1': due({ scheduledAt: new Date(T0 - min(1)).toISOString() }), ...USER });
  await s.run();
  assert.equal(s.db._get('reminders/r1').status, 'sent');
});

test('a run is bounded: at most MAX_SEND_PER_RUN sends, the rest wait for the next run', async () => {
  const seed = { ...USER };
  for (let i = 0; i < D.MAX_SEND_PER_RUN + 7; i++) seed[`reminders/r${i}`] = due({ scheduledAt: ts(T0 - min(1) - i) });
  const s = setup(seed);
  await s.run();
  assert.equal(s.calls.length, D.MAX_SEND_PER_RUN);
  assert.equal([...Array(D.MAX_SEND_PER_RUN + 7).keys()].filter(i => s.db._get(`reminders/r${i}`).status === 'pending').length, 7);
  await s.run();
  assert.equal(s.calls.length, D.MAX_SEND_PER_RUN + 7);
});

test('a run stops starting new sends once its time budget is spent', async () => {
  const clock = { t: T0 };
  const s = setup({ 'reminders/a': due({ scheduledAt: ts(T0 - min(3)) }), 'reminders/b': due({ scheduledAt: ts(T0 - min(2)) }), ...USER }, {
    clock, send: () => { clock.t += D.TIME_BUDGET_MS + 1; return { ok: true, status: 200, payload: { ok: true } }; },
  });
  await s.run();
  assert.equal(s.calls.length, 1);
  assert.equal(s.db._get('reminders/b').status, 'pending');
});

test('habit hook: a reminder the hook cancels is not sent and gets the given status', async () => {
  const s = setup({ 'reminders/r1': due({ type: 'habit_reminder', habitId: 'h1' }), ...USER }, { shouldSkip: async () => ({ status: 'cancelled', reason: 'habit_no_longer_due' }) });
  await s.run();
  assert.equal(s.calls.length, 0);
  assert.equal(s.db._get('reminders/r1').status, 'cancelled');
  // A failing hook fails open: the reminder is still delivered.
  const s2 = setup({ 'reminders/r1': due({ type: 'habit_reminder', habitId: 'h1' }), ...USER }, { shouldSkip: async () => { throw new Error('x'); } });
  await s2.run();
  assert.equal(s2.db._get('reminders/r1').status, 'sent');
});

test('logs and stored errors never contain the message text, title or chat id', async () => {
  const secretText = 'TOP-SECRET-TASK-TEXT';
  const s = setup({
    'reminders/a': due({ title: secretText, telegramText: secretText, chatId: 31337 }),
    'reminders/b': due({ title: secretText, telegramText: secretText, chatId: 31337, scheduledAt: ts(T0 - min(2)) }),
    'users/u1': { chatId: 31337 },
  }, { send: (c, t, n) => (n === 1 ? { ok: false, status: 502, payload: { description: 'Bad Gateway' } } : { ok: false, status: 403, payload: { description: 'Forbidden' } }) });
  await s.run();
  const blob = JSON.stringify(s.logs);
  for (const needle of [secretText, '31337']) assert.ok(!blob.includes(needle), `log leaked ${needle}`);
  assert.ok(s.logs.length >= 2);
  for (const id of ['a', 'b']) {
    const doc = JSON.stringify(s.db._get(`reminders/${id}`).lastError) + JSON.stringify(s.db._get(`reminders/${id}`).lastErrorDetail);
    assert.ok(!doc.includes(secretText));
  }
});

test('classification table', () => {
  assert.equal(D.classifySendResult({ ok: true, status: 200 }).kind, 'sent');
  assert.equal(D.classifySendResult({ ok: false, status: 429, payload: {} }).kind, 'retry');
  assert.equal(D.classifySendResult({ ok: false, status: 500, payload: {} }).kind, 'retry');
  assert.equal(D.classifySendResult({ ok: false, status: 403, payload: {} }).kind, 'terminal');
  assert.equal(D.classifySendResult(undefined).kind, 'retry');
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.deepEqual(D.classifyThrown(timeout), { kind: 'retry', code: 'send_timeout' });
  assert.equal(D.classifyThrown(new EnvIsolationError('DEV_EGRESS_FOREIGN_BOT')).kind, 'terminal');
  assert.equal(D.backoffMs(1), 60_000);
  assert.equal(D.backoffMs(20), 3_600_000);
});
