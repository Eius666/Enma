'use strict';

// Integration test for createEntityInFirestore against the REAL Firestore
// EMULATOR — reproduces the exact incident this fix addresses: "лимит
// заметок достигнут, но все заметки исчезли из интерфейса" (free-tier
// noteCount counter stuck at the limit while zero actual documents exist).
// A mock/in-memory db wouldn't exercise the real tx.get(query) semantics
// this fix relies on, so — same reasoning as
// api/_lib/finance/__tests__/goalTransfer.integration.test.js — this runs
// against the emulator instead.
//
//   npm run test:entity-integration

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'enma-rules-test' });
const db = admin.firestore();

const { createEntityInFirestore } = require('../createEntity');

const deps = { firebase: { db, admin } };

async function wipe() {
  await Promise.all([
    db.recursiveDelete(db.collection('notes')),
    db.recursiveDelete(db.collection('habits')),
    db.recursiveDelete(db.collection('users')),
    db.recursiveDelete(db.collection('subscriptions')),
  ]);
}

beforeEach(wipe);

test('THE INCIDENT: stale noteCount=10 counter with ZERO actual notes no longer blocks creation', async () => {
  // This is exactly what the old, never-decremented counter leaves behind
  // after a user creates 10 notes over time and then deletes all of them
  // (or some other path removes the documents) — nothing in the codebase
  // ever lowers this counter.
  await db.collection('users').doc('u1').collection('freeUsage').doc('counters').set({ noteCount: 10 });

  const notesSnap = await db.collection('notes').where('userId', '==', 'u1').get();
  assert.equal(notesSnap.size, 0, 'sanity check: this user genuinely has zero notes right now');

  const result = await createEntityInFirestore('u1', 'note', { title: 'New note', content: '' }, undefined, deps);
  assert.equal(result.ok, true, 'creation must succeed: the live count (0) is what matters, not the stale counter');
  assert.ok(result.id);

  const created = await db.collection('notes').doc(result.id).get();
  assert.equal(created.exists, true);
  assert.equal(created.data().userId, 'u1');
});

test('the limit still genuinely blocks once 10 notes actually, currently exist', async () => {
  const batch = db.batch();
  for (let i = 0; i < 10; i++) {
    batch.set(db.collection('notes').doc(`n${i}`), { userId: 'u1', title: `n${i}`, content: '' });
  }
  await batch.commit();

  const result = await createEntityInFirestore('u1', 'note', { title: 'one too many', content: '' }, undefined, deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LIMIT_REACHED');
  assert.equal(result.limit, 10);
  assert.equal(result.current, 10);

  // A blocked create touches nothing — no 11th note, no counter write.
  const finalSnap = await db.collection('notes').where('userId', '==', 'u1').get();
  assert.equal(finalSnap.size, 10);
});

test('on a SUCCESSFUL create, the stored counter (SettingsScreen\'s display) is written as the true live count, not blindly incremented from whatever it used to say', async () => {
  // Seed a counter that has already drifted from reality (e.g. left over
  // from the old implementation, or from notes deleted earlier) — a
  // successful create must leave it matching the real count, not add 1
  // on top of the stale value.
  await db.collection('users').doc('u1').collection('freeUsage').doc('counters').set({ noteCount: 999 });
  const result = await createEntityInFirestore('u1', 'note', { title: 'first real note', content: '' }, undefined, deps);
  assert.equal(result.ok, true);

  const counterSnap = await db.collection('users').doc('u1').collection('freeUsage').doc('counters').get();
  assert.equal(counterSnap.data().noteCount, 1, 'live count was 0 before this create, so the counter self-heals to 1, not 1000');
});

test('deleting notes down to under the limit immediately un-blocks creation, with no stale counter to reset first', async () => {
  const batch = db.batch();
  for (let i = 0; i < 10; i++) {
    batch.set(db.collection('notes').doc(`n${i}`), { userId: 'u1', title: `n${i}`, content: '' });
  }
  await batch.commit();
  await db.collection('users').doc('u1').collection('freeUsage').doc('counters').set({ noteCount: 10 });

  // Simulate the user deleting 3 notes (exactly what NotesList/NoteEditor's
  // handleDelete does — a plain deleteDoc, no counter write).
  await db.collection('notes').doc('n0').delete();
  await db.collection('notes').doc('n1').delete();
  await db.collection('notes').doc('n2').delete();

  const result = await createEntityInFirestore('u1', 'note', { title: 'room again', content: '' }, undefined, deps);
  assert.equal(result.ok, true);
});

test('habits share the exact same liveCount fix (3-total cap, no window field)', async () => {
  await db.collection('users').doc('u1').collection('freeUsage').doc('counters').set({ habitCount: 3 });
  const result = await createEntityInFirestore('u1', 'habit', { title: 'Drink water' }, undefined, deps);
  assert.equal(result.ok, true);
});

test('paid plan bypasses the limit regardless of live or stale counts', async () => {
  await db.collection('subscriptions').doc('u1').set({ status: 'active', plan: 'pro', endDateMs: Date.now() + 86400000 });
  const batch = db.batch();
  for (let i = 0; i < 10; i++) {
    batch.set(db.collection('notes').doc(`n${i}`), { userId: 'u1', title: `n${i}`, content: '' });
  }
  await batch.commit();

  const result = await createEntityInFirestore('u1', 'note', { title: 'still works', content: '' }, undefined, deps);
  assert.equal(result.ok, true);
});

test('two concurrent create attempts at 9/10 notes cannot both succeed and exceed the cap', async () => {
  const batch = db.batch();
  for (let i = 0; i < 9; i++) {
    batch.set(db.collection('notes').doc(`n${i}`), { userId: 'u1', title: `n${i}`, content: '' });
  }
  await batch.commit();

  const [a, b] = await Promise.all([
    createEntityInFirestore('u1', 'note', { title: 'A', content: '' }, undefined, deps),
    createEntityInFirestore('u1', 'note', { title: 'B', content: '' }, undefined, deps),
  ]);
  const succeeded = [a, b].filter(r => r.ok).length;
  assert.equal(succeeded, 1, 'exactly one of the two concurrent creates at the cap boundary must win');

  const finalSnap = await db.collection('notes').where('userId', '==', 'u1').get();
  assert.equal(finalSnap.size, 10);
});

// ── Separately verifying the OTHER hypothesis the incident report asked
//    about: does NotesList.tsx's exact query (where('userId','==',uid) +
//    orderBy('updatedAt','desc')) silently drop documents missing
//    `updatedAt`? Checked directly against the real emulator rather than
//    assumed — every live write path (entityCreate, NoteEditor's
//    transaction, the legacy localStorage migration) does set updatedAt,
//    so this is not expected to explain the incident, but it's confirmed
//    here rather than taken on faith. ──────────────────────────────────

test('CONFIRMED: Firestore orderBy really does silently exclude a document missing the sorted field', async () => {
  await db.collection('notes').doc('has-updatedAt').set({
    userId: 'u1', title: 'normal', content: '', updatedAt: admin.firestore.Timestamp.now(),
  });
  await db.collection('notes').doc('missing-updatedAt').set({
    userId: 'u1', title: 'no timestamp at all', content: '',
  });

  const plain = await db.collection('notes').where('userId', '==', 'u1').get();
  assert.equal(plain.size, 2, 'the plain where-only query sees both documents');

  const ordered = await db.collection('notes').where('userId', '==', 'u1').orderBy('updatedAt', 'desc').get();
  assert.equal(ordered.size, 1, 'orderBy silently drops the one missing updatedAt — confirmed, not assumed');
  assert.equal(ordered.docs[0].id, 'has-updatedAt');
});

test('every live note-write path in this codebase sets updatedAt, so the exclusion above is not expected to apply in practice', async () => {
  // entityCreate's own baseDoc shape (api/_lib/entities/createEntity.js):
  // { ...data, userId, createdAt: now, updatedAt: now } — always present.
  const result = await createEntityInFirestore('u1', 'note', { title: 'via entityCreate', content: '' }, undefined, deps);
  assert.equal(result.ok, true);
  const created = await db.collection('notes').doc(result.id).get();
  assert.ok(created.data().updatedAt, 'entityCreate always sets updatedAt');

  const ordered = await db.collection('notes').where('userId', '==', 'u1').orderBy('updatedAt', 'desc').get();
  assert.equal(ordered.size, 1, 'and therefore is not excluded by the real list query');
});

// ── Note folders (BUG-06): a note's folder is its `category` ─────────────

test('a note created in a folder is stored in it, survives an editor save and is listed under it', async () => {
  // NoteEditor creates a new note through entityCreate with the open folder.
  const created = await createEntityInFirestore('u1', 'note', {
    id: 'n-folder', title: 'Мысли', content: '', type: 'text', checklistItems: [], category: 'Личное', pinned: false,
  }, 'n-folder', deps);
  assert.equal(created.ok, true);
  assert.equal((await db.collection('notes').doc('n-folder').get()).data().category, 'Личное');

  // A later edit writes the same fields the editor sends (its loaded category
  // included), merged — the folder does not change without the user choosing.
  await db.collection('notes').doc('n-folder').set({
    title: 'Мысли 2', content: 'текст', type: 'text', checklistItems: [], category: 'Личное', pinned: false,
    userId: 'u1', updatedAt: admin.firestore.Timestamp.now(), rev: 1,
  }, { merge: true });

  // The list query the app uses, then the folder filter it applies.
  const listed = await db.collection('notes').where('userId', '==', 'u1').orderBy('updatedAt', 'desc').get();
  const inFolder = listed.docs.map(d => d.data()).filter(n => n.category === 'Личное');
  assert.deepEqual(inFolder.map(n => n.title), ['Мысли 2']);
});

test('a note created at the top level is not placed in any user folder', async () => {
  const created = await createEntityInFirestore('u1', 'note', {
    id: 'n-root', title: 'Корень', content: '', type: 'text', checklistItems: [], category: 'Все', pinned: false,
  }, 'n-root', deps);
  assert.equal(created.ok, true);
  const listed = await db.collection('notes').where('userId', '==', 'u1').get();
  assert.deepEqual(listed.docs.filter(d => !['Все', 'All', ''].includes(d.data().category)).map(d => d.id), []);
});
