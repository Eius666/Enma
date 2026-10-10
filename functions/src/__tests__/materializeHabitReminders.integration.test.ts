/**
 * Integration tests for the real Firestore glue around habit reminders —
 * materializeHabitRemindersHandler, sendDueRemindersHandler, and how they
 * interact through the `reminders` collection. Runs against the FIRESTORE
 * EMULATOR (never production, never real Telegram):
 *
 *   npm run test:functions-integration
 *
 * (mirrors the existing test:rules / test:migration convention of this
 * repo — emulator-backed tests are kept out of the default `test:unit`
 * run, which must stay instant and infra-free.)
 */

/* eslint-disable import/first -- deliberate: tsc's CommonJS emit keeps
   `require()` calls in source order (unlike true ESM hoisting), so these
   env vars MUST be set textually before importing ../index, which reads
   them at module-load time via initializeApp(). */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'enma-rules-test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token'; // never a real token — emulator-only run

// Importing ../index triggers its own initializeApp() for the default app.
import { materializeHabitRemindersHandler, sendDueRemindersHandler } from '../index';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const db = getFirestore();

// ── Telegram fetch mock — these tests must NEVER hit the real Telegram API ──

type FetchCall = { url: string; body: unknown };
let fetchCalls: FetchCall[] = [];
let fetchResponder: (call: FetchCall) => { ok: boolean; status: number; json: unknown } = () => ({
  ok: true, status: 200, json: { ok: true },
});

const originalFetch = globalThis.fetch;

function installFetchMock() {
  fetchCalls = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: { body?: string }
  ) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call = { url: String(url), body };
    fetchCalls.push(call);
    const r = fetchResponder(call);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.json,
    } as unknown as Response;
  }) as typeof fetch;
}

function restoreFetchMock() {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

async function wipeCollection(name: string) {
  await db.recursiveDelete(db.collection(name));
}

async function setUser(uid: string, chatId: number, timezone?: string) {
  await db.collection('users').doc(uid).set({ chatId, ...(timezone ? { timezone } : {}) });
}

async function setHabit(id: string, data: Record<string, unknown>) {
  await db.collection('habits').doc(id).set({
    userId: 'u1',
    title: 'Test habit',
    repeatType: 'daily',
    archived: false,
    createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')),
    ...data,
  });
}

async function getReminder(docId: string) {
  const snap = await db.collection('reminders').doc(docId).get();
  return snap.exists ? snap.data() : null;
}

before(() => {
  installFetchMock();
});

beforeEach(async () => {
  await Promise.all([wipeCollection('habits'), wipeCollection('reminders'), wipeCollection('users')]);
  fetchCalls = [];
  fetchResponder = () => ({ ok: true, status: 200, json: { ok: true } });
});

// ── 1. habit exists → reminder created ──────────────────────────────────────

test('an active habit with a reminder time gets a reminder created', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });

  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1);
  assert.equal(snap.docs[0].data().status, 'pending');
  assert.equal(snap.docs[0].data().chatId, 111222333);
});

// ── 2. archived → no reminder ────────────────────────────────────────────────

test('an archived habit never gets a reminder', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00', archived: true });

  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 0);
});

// ── 3. notifications disabled (no reminderTime) → no reminder ──────────────

test('a habit with no reminderTime never gets a reminder', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: null });

  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 0);
});

// ── 4. repeated materializer run → no duplicate ─────────────────────────────

test('running the materializer twice does not create a second reminder', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });

  await materializeHabitRemindersHandler();
  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1);
});

// ── 5. two PARALLEL materializer runs → only one occurrence ─────────────────

test('two concurrent materializer runs still create exactly one occurrence', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });

  // Real Firestore, real atomic create() — this is exactly what a naive
  // mock couldn't meaningfully prove.
  await Promise.all([materializeHabitRemindersHandler(), materializeHabitRemindersHandler()]);

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1);
});

// ── 6. time changed → old occurrence rescheduled, not duplicated ───────────

test('changing reminderTime reschedules the existing pending occurrence in place', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });
  await materializeHabitRemindersHandler();

  const snap1 = await db.collection('reminders').where('habitId', '==', 'h1').get();
  const docId = snap1.docs[0].id;
  const firstScheduledAt = snap1.docs[0].data().scheduledAt as Timestamp;

  await db.collection('habits').doc('h1').update({ reminderTime: '18:00' });
  await materializeHabitRemindersHandler();

  const snap2 = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap2.size, 1); // still exactly one doc, same id
  assert.equal(snap2.docs[0].id, docId);
  const secondScheduledAt = snap2.docs[0].data().scheduledAt as Timestamp;
  assert.notEqual(secondScheduledAt.toMillis(), firstScheduledAt.toMillis());
});

// ── 7. days changed → stale pending occurrence is cancelled ────────────────

test('removing today from repeatDays cancels an already-pending occurrence for today', async () => {
  await setUser('u1', 111222333);
  // Daily (due regardless of real-world weekday the test happens to run on)
  // so the first materialization is deterministic without hardcoding "today".
  await setHabit('h1', { repeatType: 'daily', reminderTime: '18:00' });
  await materializeHabitRemindersHandler();
  const before1 = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(before1.size, 1);
  assert.equal(before1.docs[0].data().status, 'pending');

  // User switches to specific days that exclude today, whatever today is.
  await db.collection('habits').doc('h1').update({ repeatType: 'custom', repeatDays: [] });
  await materializeHabitRemindersHandler();

  const after1 = await db.collection('reminders').doc(before1.docs[0].id).get();
  assert.equal(after1.data()?.status, 'cancelled');
});

// ── 8. habit deleted → pending reminder is cancelled, never sent ───────────

test('deleting a habit after its reminder was materialized cancels delivery instead of sending', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });
  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  const docId = snap.docs[0].id;
  // Backdate it so sendDueReminders will treat it as due right now.
  await db.collection('reminders').doc(docId).update({ scheduledAt: Timestamp.now() });

  await db.collection('habits').doc('h1').delete();

  await sendDueRemindersHandler();

  const after1 = await getReminder(docId);
  assert.equal(after1?.status, 'cancelled');
  assert.equal(fetchCalls.length, 0); // Telegram was never called
});

// ── 9. Firestore error at the outer read → controlled, non-throwing failure ─

test('materializeHabitRemindersHandler never throws even when a habit document is malformed', async () => {
  // No userId at all — must be skipped silently, not crash the whole run.
  await db.collection('habits').doc('broken').set({ reminderTime: '09:00', archived: false });
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });

  await assert.doesNotReject(() => materializeHabitRemindersHandler());

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1); // the healthy habit was still processed
});

// ── 10. non-UTC timezone ─────────────────────────────────────────────────────

test('a habit for a user in Asia/Shanghai is scheduled using that timezone, not UTC', async () => {
  await setUser('u1', 111222333, 'Asia/Shanghai');
  await setHabit('h1', { reminderTime: '09:00' });

  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1);
  const scheduledAt = (snap.docs[0].data().scheduledAt as Timestamp).toDate();
  // 09:00 Asia/Shanghai (UTC+8) == 01:00 UTC.
  assert.equal(scheduledAt.getUTCHours(), 1);
});

// ── 11. reminder time between materializer runs is still materialized ahead ─

test('a reminder later today is materialized immediately, not only once it becomes due', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '23:55' }); // almost certainly still in the future "now"

  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  assert.equal(snap.size, 1);
  assert.equal(snap.docs[0].data().status, 'pending');
  // It exists well before its scheduledAt — sendDueReminders' own 1-minute
  // poll is what provides delivery precision, not the materializer's cadence.
  const scheduledAt = (snap.docs[0].data().scheduledAt as Timestamp).toMillis();
  assert.ok(scheduledAt > Date.now());
});

// ── 12. a due reminder is successfully delivered by sendDueReminders ───────

test('a due habit reminder is delivered and marked sent', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });
  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  const docId = snap.docs[0].id;
  await db.collection('reminders').doc(docId).update({ scheduledAt: Timestamp.now() });

  await sendDueRemindersHandler();

  const after1 = await getReminder(docId);
  assert.equal(after1?.status, 'sent');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /sendMessage$/);
});

// ── 13. repeated delivery worker run does not double-send ───────────────────

test('running sendDueReminders twice after a successful send does not send again', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });
  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  const docId = snap.docs[0].id;
  await db.collection('reminders').doc(docId).update({ scheduledAt: Timestamp.now() });

  await sendDueRemindersHandler();
  await sendDueRemindersHandler();

  assert.equal(fetchCalls.length, 1); // Telegram called exactly once
  const final = await getReminder(docId);
  assert.equal(final?.status, 'sent');
});

// ── bonus: Telegram failure path doesn't lose the reminder ──────────────────

test('a Telegram 5xx leaves the reminder pending for retry, not lost or duplicated', async () => {
  await setUser('u1', 111222333);
  await setHabit('h1', { reminderTime: '09:00' });
  await materializeHabitRemindersHandler();

  const snap = await db.collection('reminders').where('habitId', '==', 'h1').get();
  const docId = snap.docs[0].id;
  await db.collection('reminders').doc(docId).update({ scheduledAt: Timestamp.now() });

  fetchResponder = () => ({ ok: false, status: 500, json: { ok: false, description: 'Internal Server Error' } });
  await sendDueRemindersHandler();

  const after1 = await getReminder(docId);
  assert.equal(after1?.status, 'pending'); // retry, not failed/lost
  assert.equal((after1?.retryCount as number), 1);

  // Confirm it's not re-sent again THIS instant (scheduledAt was pushed into the future by backoff).
  fetchResponder = () => ({ ok: true, status: 200, json: { ok: true } });
  await sendDueRemindersHandler();
  assert.equal(fetchCalls.length, 1); // still only the one failed attempt — the retry isn't due yet
});

after(restoreFetchMock);
