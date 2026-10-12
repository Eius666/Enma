import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteConflictError, classifyWriteError } from '../noteSyncStatus.ts';

test('classifyWriteError: a NoteConflictError is classified as conflict', () => {
  assert.equal(classifyWriteError(new NoteConflictError(3)), 'conflict');
});

test('classifyWriteError: NoteConflictError carries the server revision that caused it', () => {
  const err = new NoteConflictError(7);
  assert.equal(err.serverRev, 7);
  assert.equal(err.code, 'note/conflict');
});

for (const code of ['unavailable', 'deadline-exceeded', 'resource-exhausted']) {
  test(`classifyWriteError: Firestore code "${code}" is classified as network`, () => {
    assert.equal(classifyWriteError({ code }), 'network');
  });
}

test('classifyWriteError: permission-denied is NOT classified as network (it is a real rejection, not a hang)', () => {
  assert.equal(classifyWriteError({ code: 'permission-denied' }), 'other');
});

test('classifyWriteError: a plain Error with no .code falls back to other', () => {
  assert.equal(classifyWriteError(new Error('boom')), 'other');
});

test('classifyWriteError: null/undefined/non-object inputs fall back to other without throwing', () => {
  assert.equal(classifyWriteError(null), 'other');
  assert.equal(classifyWriteError(undefined), 'other');
  assert.equal(classifyWriteError('just a string'), 'other');
});
