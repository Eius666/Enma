import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKey,
  decideDraftAction,
  createInMemoryDraftStoreForTests,
  createFailingDraftStoreForTests,
  createFlakyDraftStoreForTests,
  createDraftStoreWithRawEntryForTests,
} from '../noteDrafts.ts';
import type { NoteDraft } from '../noteDrafts.ts';

function makeDraft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    uid: 'alice',
    noteId: 'n1',
    title: 'Shopping',
    content: 'milk, eggs',
    type: 'text',
    checklistItems: [],
    category: 'General',
    pinned: false,
    baseRev: 2,
    savedAtLocal: 1700000000000,
    ...overrides,
  };
}

// ── draftKey ─────────────────────────────────────────────────────────────

test('draftKey: namespaces by uid so two users never collide on the same noteId', () => {
  assert.notEqual(draftKey('alice', 'n1'), draftKey('bob', 'n1'));
  assert.equal(draftKey('alice', 'n1'), 'alice::n1');
});

// ── decideDraftAction (pure) ────────────────────────────────────────────

test('decideDraftAction: no draft at all -> none', () => {
  assert.equal(decideDraftAction(null, 5), 'none');
});

test('decideDraftAction: draft matches the server revision it was based on -> restore', () => {
  assert.equal(decideDraftAction(makeDraft({ baseRev: 5 }), 5), 'restore');
});

test('decideDraftAction: server has moved on past the draft -> conflict (never silently overwrite a newer version)', () => {
  assert.equal(decideDraftAction(makeDraft({ baseRev: 2 }), 5), 'conflict');
});

test('decideDraftAction: draft rev ahead of server (should not normally happen) fails open to restore, not data loss', () => {
  assert.equal(decideDraftAction(makeDraft({ baseRev: 9 }), 5), 'restore');
});

// ── NoteDraftStore (in-memory backend — exercises the same code paths the
//    real IndexedDB backend runs, without touching a browser API) ───────

test('NoteDraftStore: round-trips save -> load, and save() resolves true only once the write actually completed', async () => {
  const store = createInMemoryDraftStoreForTests();
  const draft = makeDraft();
  const ok = await store.save(draft);
  assert.equal(ok, true);
  const loaded = await store.load('alice', 'n1');
  assert.deepEqual(loaded, draft);
});

test('NoteDraftStore: load with no saved draft returns null', async () => {
  const store = createInMemoryDraftStoreForTests();
  assert.equal(await store.load('alice', 'does-not-exist'), null);
});

test('NoteDraftStore: clear removes the draft', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft());
  await store.clear('alice', 'n1');
  assert.equal(await store.load('alice', 'n1'), null);
});

test('NoteDraftStore: drafts for different uids never mix, even for the same noteId', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft({ uid: 'alice', content: 'alice content' }));
  await store.save(makeDraft({ uid: 'bob', content: 'bob content' }));
  assert.equal((await store.load('alice', 'n1'))?.content, 'alice content');
  assert.equal((await store.load('bob', 'n1'))?.content, 'bob content');
  await store.clear('bob', 'n1');
  // Clearing bob's draft must not touch alice's.
  assert.equal((await store.load('alice', 'n1'))?.content, 'alice content');
});

test('NoteDraftStore: load defends against a draft whose stored uid/noteId do not match the lookup', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft({ uid: 'alice', noteId: 'n1' }));
  // Looking it up under a different uid must never return alice's draft,
  // even if some corruption put it under the wrong key.
  assert.equal(await store.load('mallory', 'n1'), null);
});

test('NoteDraftStore: a saved draft with new content overwrites the previous one for the same key', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft({ content: 'first' }));
  await store.save(makeDraft({ content: 'second' }));
  assert.equal((await store.load('alice', 'n1'))?.content, 'second');
});

// ── listForUser (recovering new notes that never reached Firestore) ─────

test('listForUser: returns every draft saved for that uid', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft({ uid: 'alice', noteId: 'n1' }));
  await store.save(makeDraft({ uid: 'alice', noteId: 'n2' }));
  const drafts = await store.listForUser('alice');
  assert.deepEqual(drafts.map(d => d.noteId).sort(), ['n1', 'n2']);
});

test('listForUser: never includes another uid\'s drafts', async () => {
  const store = createInMemoryDraftStoreForTests();
  await store.save(makeDraft({ uid: 'alice', noteId: 'n1' }));
  await store.save(makeDraft({ uid: 'bob', noteId: 'n2' }));
  const drafts = await store.listForUser('alice');
  assert.deepEqual(drafts.map(d => d.noteId), ['n1']);
});

test('listForUser: returns an empty array, not an error, when nothing is saved', async () => {
  const store = createInMemoryDraftStoreForTests();
  assert.deepEqual(await store.listForUser('alice'), []);
});

test('load(): a corrupted (not valid JSON) entry is treated as absent, not thrown', async () => {
  const store = createDraftStoreWithRawEntryForTests('alice::bad', '{not-json');
  assert.equal(await store.load('alice', 'bad'), null);
});

test('listForUser: skips a corrupted entry instead of failing the whole listing', async () => {
  const store = createDraftStoreWithRawEntryForTests('alice::bad', '{not-json');
  await store.save(makeDraft({ uid: 'alice', noteId: 'good' }));
  const drafts = await store.listForUser('alice');
  assert.deepEqual(drafts.map(d => d.noteId), ['good']);
});

// ── Local-storage failure handling (PHASE: "обработка ошибок локального
//    хранилища") — every method must degrade gracefully, never throw, and
//    never block/break the caller (the real Firestore write path does not
//    depend on any of this succeeding). ──────────────────────────────────

test('A fully unavailable backend: save() resolves false, never rejects', async () => {
  const store = createFailingDraftStoreForTests();
  const ok = await store.save(makeDraft());
  assert.equal(ok, false);
});

test('A fully unavailable backend: load() resolves null, never rejects', async () => {
  const store = createFailingDraftStoreForTests();
  assert.equal(await store.load('alice', 'n1'), null);
});

test('A fully unavailable backend: clear() resolves (no-op), never rejects', async () => {
  const store = createFailingDraftStoreForTests();
  await assert.doesNotReject(() => store.clear('alice', 'n1'));
});

test('A fully unavailable backend: listForUser() resolves [], never rejects', async () => {
  const store = createFailingDraftStoreForTests();
  assert.deepEqual(await store.listForUser('alice'), []);
});

test('A flaky backend (every 2nd write fails, e.g. intermittent quota pressure): failed saves are reported false, successful ones are not lost', async () => {
  const store = createFlakyDraftStoreForTests(2);
  const first = await store.save(makeDraft({ content: 'v1' }));   // call 1: succeeds
  const second = await store.save(makeDraft({ content: 'v2' }));  // call 2: simulated failure
  assert.equal(first, true);
  assert.equal(second, false);
  // The last successful write (v1) must still be readable — a failed
  // later save must not have corrupted or half-written anything.
  assert.equal((await store.load('alice', 'n1'))?.content, 'v1');
});
