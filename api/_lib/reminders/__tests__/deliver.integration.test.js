'use strict';

// processDueReminders against the REAL Firestore emulator: the claim
// transaction must keep concurrent workers from sending the same reminder
// twice. Telegram is a counting fake.
//   npm run test:reminders-integration

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'enma-rules-test' });
const db = admin.firestore();
const { Timestamp, FieldValue } = admin.firestore;
const D = require('../deliver');

const NOW = Date.now();
const min = (n) => n * 60 * 1000;

function makeRun(sent, { send } = {}) {
  return () => D.processDueReminders({
    db,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    fromMillis: (ms) => Timestamp.fromMillis(ms),
    send: async (chatId, text) => {
      sent.push(text);
      await new Promise(r => setTimeout(r, 5)); // widen the race window
      return send ? send(chatId, text) : { ok: true, status: 200, payload: { ok: true } };
    },
    isRecipientAllowed: () => true,
    log: () => {},
  });
}
const wipe = async () => { await Promise.all([db.recursiveDelete(db.collection('reminders')), db.recursiveDelete(db.collection('users'))]); };
beforeEach(wipe);

const seed = async (n, over = {}) => {
  await db.collection('users').doc('u1').set({ chatId: 555 });
  await Promise.all(Array.from({ length: n }, (_, i) => db.collection('reminders').doc(`r${i}`).set({
    userId: 'u1', chatId: 555, title: `t${i}`, telegramText: `msg-${i}`, status: 'pending',
    scheduledAt: Timestamp.fromMillis(NOW - min(1) - i), retryCount: 0, ...over,
  })));
};

test('two concurrent workers: every reminder is sent exactly once', async () => {
  await seed(12);
  const sent = [];
  const run = makeRun(sent);
  await Promise.all([run(), run()]);
  assert.equal(sent.length, 12, JSON.stringify(sent));
  assert.equal(new Set(sent).size, 12, 'no duplicates');
  const docs = (await db.collection('reminders').get()).docs.map(d => d.data().status);
  assert.deepEqual([...new Set(docs)], ['sent']);
});

test('six concurrent workers still send each reminder once', async () => {
  await seed(10);
  const sent = [];
  const run = makeRun(sent);
  await Promise.all(Array.from({ length: 6 }, () => run()));
  assert.equal(sent.length, 10);
  assert.equal(new Set(sent).size, 10);
});

test('a worker that crashed after claiming: after the lease expires another worker re-queues it, then it is delivered', async () => {
  await db.collection('users').doc('u1').set({ chatId: 555 });
  await db.collection('reminders').doc('crashed').set({
    userId: 'u1', chatId: 555, title: 't', telegramText: 'msg-crashed', status: 'sending', claimId: 'dead-worker',
    leaseUntil: Timestamp.fromMillis(NOW - 1000), scheduledAt: Timestamp.fromMillis(NOW - min(10)), retryCount: 0,
  });
  const sent = [];
  await makeRun(sent)();
  let doc = (await db.collection('reminders').doc('crashed').get()).data();
  assert.equal(doc.status, 'pending');
  assert.equal(doc.retryCount, 1);
  assert.equal(sent.length, 0, 'not resent in the same run: it waits for its backoff');
  await db.collection('reminders').doc('crashed').update({ scheduledAt: Timestamp.fromMillis(NOW - 1000) }); // backoff elapsed
  await makeRun(sent)();
  doc = (await db.collection('reminders').doc('crashed').get()).data();
  assert.deepEqual(sent, ['msg-crashed']);
  assert.equal(doc.status, 'sent');
});

test('one failing reminder among many does not block the rest (real transactions)', async () => {
  await seed(5);
  const sent = [];
  await makeRun(sent, { send: (c, text) => (text === 'msg-2' ? { ok: false, status: 403, payload: { description: 'Forbidden' } } : { ok: true, status: 200, payload: {} }) })();
  const statuses = Object.fromEntries((await db.collection('reminders').get()).docs.map(d => [d.id, d.data().status]));
  assert.equal(statuses.r2, 'failed');
  assert.deepEqual(Object.entries(statuses).filter(([id]) => id !== 'r2').map(([, s]) => s), ['sent', 'sent', 'sent', 'sent']);
});

test('old reminders become expired in the real database and are still there afterwards', async () => {
  await seed(3, { scheduledAt: Timestamp.fromMillis(NOW - D.MAX_LATE_MS - min(5)) });
  const sent = [];
  await makeRun(sent)();
  assert.equal(sent.length, 0);
  const snap = await db.collection('reminders').get();
  assert.equal(snap.size, 3);
  assert.ok(snap.docs.every(d => d.data().status === 'expired'));
});
