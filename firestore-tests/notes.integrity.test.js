'use strict';

// The notes write protocol against the Firestore emulator and the real rules:
// what the `rev` check in NoteEditor (src/components/NoteEditor.tsx,
// writeNote) does and does not protect, and how a read behaves with the
// network off. Invented data, demo project only. Run with:
//   firebase emulators:exec --only firestore --project enma-rules-test "node --test firestore-tests/notes.integrity.test.js"
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { initializeTestEnvironment, assertSucceeds } = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, updateDoc, onSnapshot, runTransaction, serverTimestamp, disableNetwork, enableNetwork, increment,
} = require('firebase/firestore');

let env;

// A note from before `rev` existed (or created by the server): no rev field.
const LEGACY = { id: 'n1', userId: 'alice', title: 'Список покупок', content: 'молоко\nхлеб', type: 'text', checklistItems: [], category: 'Личное', pinned: true };

class Conflict extends Error {}

// The same transaction NoteEditor's writeNote runs for an existing note.
async function editorWrite(db, id, knownRev, fields) {
  const ref = doc(db, 'notes', id);
  let nextRev = 0;
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const serverRev = snap.exists() && typeof snap.data().rev === 'number' ? snap.data().rev : 0;
    if (knownRev !== serverRev) throw new Conflict(String(serverRev));
    nextRev = serverRev + 1;
    tx.set(ref, { ...fields, userId: 'alice', updatedAt: serverTimestamp(), rev: nextRev }, { merge: true });
  });
  return nextRev;
}

const EMPTY = { title: '', content: '', type: 'text', checklistItems: [], category: 'Общее', pinned: false };

before(async () => {
  env = await initializeTestEnvironment({
    // Its own emulator project: the offline tests leave a listener behind
    // that would disturb clearing the data of the suites run after this one.
    projectId: 'enma-notes-test',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'notes/n1'), LEGACY);
    await setDoc(doc(db, 'notes/n2'), { ...LEGACY, id: 'n2', rev: 3 });
  });
});

const alice = () => env.authenticatedContext('alice').firestore();
const serverNote = async (id) => {
  let data;
  await env.withSecurityRulesDisabled(async (ctx) => { data = (await getDoc(doc(ctx.firestore(), 'notes', id))).data(); });
  return data;
};

test('a note without rev is not protected by the rev check: a write from an editor that never loaded it replaces it', async () => {
  // What the editor did after a failed load: empty fields, knownRev 0.
  await assertSucceeds(editorWrite(alice(), 'n1', 0, EMPTY));
  const after = await serverNote('n1');
  assert.equal(after.title, '');
  assert.equal(after.content, '');
  assert.equal(after.category, 'Общее');
  assert.equal(after.rev, 1);
});

test('a note with rev is protected: a write based on an older revision is refused and changes nothing', async () => {
  await assert.rejects(editorWrite(alice(), 'n2', 0, EMPTY), Conflict);
  await assert.rejects(editorWrite(alice(), 'n2', 2, { ...LEGACY, content: 'старое' }), Conflict);
  assert.deepEqual(await serverNote('n2'), { ...LEGACY, id: 'n2', rev: 3 });
});

test('once written by an editor, a note without rev is protected from then on', async () => {
  assert.equal(await editorWrite(alice(), 'n1', 0, { ...LEGACY, content: 'правка A' }), 1);
  await assert.rejects(editorWrite(alice(), 'n1', 0, { ...LEGACY, content: 'правка B' }), Conflict);
  assert.equal((await serverNote('n1')).content, 'правка A');
});

test('two devices saving one note at the same moment: exactly one write lands, the other is a conflict', async () => {
  for (const [id, base] of [['n1', 0], ['n2', 3]]) {
    const results = await Promise.allSettled([
      editorWrite(alice(), id, base, { ...LEGACY, content: 'устройство 1' }),
      editorWrite(alice(), id, base, { ...LEGACY, content: 'устройство 2' }),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled');
    const conflicts = results.filter(r => r.status === 'rejected' && r.reason instanceof Conflict);
    assert.equal(ok.length, 1, id);
    assert.equal(conflicts.length, 1, id);
    const after = await serverNote(id);
    assert.equal(after.rev, base + 1);
    assert.ok(['устройство 1', 'устройство 2'].includes(after.content));
  }
});

test('pinning from the notes list raises rev: an editor open elsewhere sees a newer version instead of writing its old pin back', async () => {
  // NotesList.handlePin
  await updateDoc(doc(alice(), 'notes/n2'), { pinned: false, updatedAt: serverTimestamp(), rev: increment(1) });
  assert.equal((await serverNote('n2')).rev, 4);
  // The open editor still holds pinned: true and rev 3.
  await assert.rejects(editorWrite(alice(), 'n2', 3, { ...LEGACY, content: 'правка' }), Conflict);
  assert.equal((await serverNote('n2')).pinned, false);
  // A note without rev: the pin gives it revision 1, so the same protection applies.
  await updateDoc(doc(alice(), 'notes/n1'), { pinned: false, updatedAt: serverTimestamp(), rev: increment(1) });
  await assert.rejects(editorWrite(alice(), 'n1', 0, { ...LEGACY, content: 'правка' }), Conflict);
  assert.deepEqual(await serverNote('n1'), { ...LEGACY, pinned: false, rev: 1, updatedAt: (await serverNote('n1')).updatedAt });
});

test('offline: reading a note this client has not loaded fails (the editor must not treat that as an empty note)', async () => {
  const db = alice();
  await disableNetwork(db);
  await assert.rejects(getDoc(doc(db, 'notes/n1')), (err) => err.code === 'unavailable');
  await enableNetwork(db);
  // Note: disableNetwork stops reads and listeners only; a transaction is a
  // separate request and still goes through, so a real loss of connection
  // during a write cannot be simulated here (src/components/__tests__/
  // NoteEditor.integrity.test.tsx covers that with a fake).
});

test('offline: a note the notes list is listening to is read from the local cache', async () => {
  const db = alice();
  const unsubscribe = await new Promise((resolve) => {
    const u = onSnapshot(doc(db, 'notes/n2'), (s) => { if (!s.metadata.fromCache) resolve(u); });
  });
  await disableNetwork(db);
  const cached = await getDoc(doc(db, 'notes/n2'));
  assert.equal(cached.metadata.fromCache, true);
  assert.equal(cached.data().content, 'молоко\nхлеб');
  unsubscribe();
  await enableNetwork(db);
});
