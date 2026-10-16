'use strict';

// AI memory (`messages`) persists across separate "sessions" in a test store
// and is isolated per store. In-memory mock only — no Firestore access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../evals/fixtures');

function load(db) {
  const fa = require.resolve('../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  delete require.cache[require.resolve('../ai/chatHistory')];
  return require('../ai/chatHistory');
}
test.afterEach(() => {
  delete require.cache[require.resolve('../firebaseAdmin')];
  delete require.cache[require.resolve('../ai/chatHistory')];
});

test('history written in one session is restored in the next (same store)', async () => {
  const db = createMockDb({});
  let h = load(db);
  await h.saveMessage('dev_user_1', 'user', 'Запомни: мой кот — Барсик');
  await h.saveMessage('dev_user_1', 'assistant', 'Хорошо, запомнил.');

  h = load(db); // "new session": fresh module instance, same test store
  const restored = await h.loadHistory('dev_user_1');
  // The in-memory mock ignores orderBy(createdAt), so order is not asserted
  // here (real ordering needs the Firestore emulator / cloud DEV).
  const byContent = Object.fromEntries(restored.map((m) => [m.content, m.role]));
  assert.deepEqual(byContent, { 'Запомни: мой кот — Барсик': 'user', 'Хорошо, запомнил.': 'assistant' });
});

test('a different store (e.g. production) is not visible to the DEV store', async () => {
  const devDb = createMockDb({});
  const otherDb = createMockDb({});
  await load(devDb).saveMessage('u1', 'user', 'dev-only');
  assert.deepEqual(await load(otherDb).loadHistory('u1'), []);
});

test('history is per user', async () => {
  const h = load(createMockDb({}));
  await h.saveMessage('a', 'user', 'for a');
  await h.saveMessage('b', 'user', 'for b');
  assert.deepEqual((await h.loadHistory('a')).map((m) => m.content), ['for a']);
});
