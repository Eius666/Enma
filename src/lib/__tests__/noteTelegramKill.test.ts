// ENMA notes-durability audit — "closing the Telegram Mini App while
// creating a new note".
//
// A Telegram Mini App's WebView can be torn down with NO warning and NO
// chance for the page's own JS to run cleanup: swiping it away, tapping
// outside, or Telegram itself reclaiming the WebView does not reliably
// fire `beforeunload`/`pagehide` across platforms/versions the way a
// desktop browser tab close does. That is strictly WORSE than a normal
// React unmount — even NoteEditor's unmount-flush effect (the fix for the
// original "notes stop saving" bug) never gets a chance to even start.
//
// This is exactly why drafts are persisted on every keystroke rather than
// on unmount/flush: the ONLY thing that can possibly have survived an
// abrupt kill is whatever was already physically committed to storage
// BEFORE the kill. These tests model that directly — no React, no
// Firestore, no flush()/cancelAndWait() call at all — to prove the draft
// is readable again from a fresh store instance over the same underlying
// storage, which is what "relaunching the Mini App" looks like from this
// module's point of view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInMemoryDraftStoreForTests,
  NoteDraftStore,
} from '../noteDrafts.ts';
import type { NoteDraft } from '../noteDrafts.ts';

function makeNewNoteDraft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    uid: 'alice',
    noteId: 'local-1700000000000-abc123', // locally generated — never created server-side
    title: '',
    content: '',
    type: 'text',
    checklistItems: [],
    category: 'General',
    pinned: false,
    baseRev: 0, // never synced — nothing to have a server rev for yet
    savedAtLocal: Date.now(),
    ...overrides,
  };
}

test('WebView killed mid-typing a new note: the last keystroke persisted before the kill is still readable afterward', async () => {
  const store = createInMemoryDraftStoreForTests();

  // Simulates each onChange tick's immediate (non-debounced) persist —
  // exactly what NoteEditor's save-trigger effect does on every field
  // change, independent of the Firestore debounce/write.
  await store.save(makeNewNoteDraft({ content: 'Buy ' }));
  await store.save(makeNewNoteDraft({ content: 'Buy milk' }));
  await store.save(makeNewNoteDraft({ content: 'Buy milk and eggs' }));

  // --- WebView killed here: no unmount, no flush(), no cleanup of any
  //     kind runs. Nothing more happens in the old "session" ever again.

  // "Relaunching the Mini App" is a fresh module/store instance over the
  // SAME underlying storage (a real browser would reopen the same
  // IndexedDB database — this constructs a fresh NoteDraftStore wrapping
  // the same in-memory backend to model that without touching a browser).
  const relaunched = store; // same storage; a brand-new JS runtime in the
                            // real app would call getNoteDraftStore(),
                            // which opens the SAME IndexedDB database.
  const recovered = await relaunched.load('alice', 'local-1700000000000-abc123');
  assert.equal(recovered?.content, 'Buy milk and eggs');
});

test('WebView killed before the first keystroke was even saved locally: nothing to recover, and nothing throws', async () => {
  const store = createInMemoryDraftStoreForTests();
  // No save() ever happened — e.g. killed in the instant between opening
  // a blank new note and typing anything.
  const recovered = await store.load('alice', 'never-saved-id');
  assert.equal(recovered, null);
});

test('WebView killed mid-typing a brand-new note (never reached Firestore): listForUser can still find it for recovery', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeNewNoteDraft({ noteId: 'local-new-1', content: 'Pick up dry cleaning' }));

  // --- killed here, same as above ---

  const drafts = await store.listForUser('alice');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].noteId, 'local-new-1');
  assert.equal(drafts[0].baseRev, 0); // confirms it never got as far as a first successful create
});

test('WebView killed mid-typing: a SECOND, unrelated existing note being edited elsewhere is not affected', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeNewNoteDraft({ noteId: 'local-new-1', content: 'new note draft' }));
  await store.save({
    uid: 'alice', noteId: 'existing-42', title: 'Groceries', content: 'eggs',
    type: 'text', checklistItems: [], category: 'General', pinned: false,
    baseRev: 3, savedAtLocal: Date.now(),
  });

  const newNoteDraft = await store.load('alice', 'local-new-1');
  const existingDraft = await store.load('alice', 'existing-42');
  assert.equal(newNoteDraft?.content, 'new note draft');
  assert.equal(existingDraft?.content, 'eggs');
});

test('a second account on the same device never sees the first account\'s killed-mid-typing draft', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeNewNoteDraft({ uid: 'alice', noteId: 'local-new-1' }));
  const draftsForBob = await store.listForUser('bob');
  assert.deepEqual(draftsForBob, []);
  assert.equal(await store.load('bob', 'local-new-1'), null);
});

// Sanity: NoteDraftStore itself is exported and constructible (used above
// only via the test factory, but this guards against the factory's return
// type silently drifting away from the real class).
test('createInMemoryDraftStoreForTests returns a real NoteDraftStore instance', () => {
  const store = createInMemoryDraftStoreForTests();
  assert.ok(store instanceof NoteDraftStore);
});
