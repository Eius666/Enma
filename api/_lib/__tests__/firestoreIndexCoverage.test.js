'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { indexServesQuery, collectionHasCoveringIndex } = require('../firestoreIndexCoverage');

// ── Pure matching-rule unit tests, independent of the real file ─────────

test('indexServesQuery: the exact incident — userId+pinned+updatedAt does NOT serve where(userId)+orderBy(updatedAt)', () => {
  const fields = [
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'pinned', order: 'DESCENDING' },
    { fieldPath: 'updatedAt', order: 'DESCENDING' },
  ];
  assert.equal(indexServesQuery(fields, ['userId'], 'updatedAt', 'DESCENDING'), false);
});

test('indexServesQuery: a plain userId+updatedAt index DOES serve it', () => {
  const fields = [
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'updatedAt', order: 'DESCENDING' },
  ];
  assert.equal(indexServesQuery(fields, ['userId'], 'updatedAt', 'DESCENDING'), true);
});

test('indexServesQuery: extra fields AFTER the orderBy field are fine (broader index still serves a narrower query)', () => {
  const fields = [
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'updatedAt', order: 'DESCENDING' },
    { fieldPath: 'category', order: 'ASCENDING' },
  ];
  assert.equal(indexServesQuery(fields, ['userId'], 'updatedAt', 'DESCENDING'), true);
});

test('indexServesQuery: wrong sort direction on the orderBy field does not match', () => {
  const fields = [
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'updatedAt', order: 'ASCENDING' },
  ];
  assert.equal(indexServesQuery(fields, ['userId'], 'updatedAt', 'DESCENDING'), false);
});

test('indexServesQuery: multiple equality fields in any order within the prefix still match', () => {
  const fields = [
    { fieldPath: 'status', order: 'ASCENDING' },
    { fieldPath: 'userId', order: 'ASCENDING' },
    { fieldPath: 'updatedAt', order: 'DESCENDING' },
  ];
  assert.equal(indexServesQuery(fields, ['userId', 'status'], 'updatedAt', 'DESCENDING'), true);
});

test('indexServesQuery: too few fields in the index cannot match', () => {
  const fields = [{ fieldPath: 'userId', order: 'ASCENDING' }];
  assert.equal(indexServesQuery(fields, ['userId'], 'updatedAt', 'DESCENDING'), false);
});

// ── THE actual regression test: the real firestore.indexes.json must
//    cover the real query NotesList.tsx runs. This is the test that
//    would have caught the incident before it ever reached production —
//    a mismatch between a query added/changed in code and the indexes
//    file is otherwise invisible until the query actually runs. ────────

test('REGRESSION: firestore.indexes.json covers notes: where(userId)+orderBy(updatedAt desc) — the exact query NotesList.tsx runs', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../../firestore.indexes.json'), 'utf8');
  const indexesJson = JSON.parse(raw);
  const covered = collectionHasCoveringIndex(indexesJson, 'notes', ['userId'], 'updatedAt', 'DESCENDING');
  assert.equal(
    covered, true,
    'firestore.indexes.json has no composite index serving notes: where(userId,"==",uid) + orderBy(updatedAt,"desc") — ' +
    'NotesList.tsx would fail with FAILED_PRECONDITION in production for every account. ' +
    'See src/components/NotesList.tsx for the exact query and api/_lib/firestoreIndexCoverage.js for the matching rule.'
  );
});

test('REGRESSION: firebase.json actually references firestore.indexes.json, so `firebase deploy` can ever deploy it', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../../../firebase.json'), 'utf8');
  const firebaseJson = JSON.parse(raw);
  assert.equal(
    firebaseJson.firestore && firebaseJson.firestore.indexes, 'firestore.indexes.json',
    'firebase.json is missing firestore.indexes — a correct firestore.indexes.json can sit in the repo forever ' +
    'without `firebase deploy --only firestore:indexes` ever picking it up. This was the actual reason the fix for ' +
    'the incident above was never deployed.'
  );
});
