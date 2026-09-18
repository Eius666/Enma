'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Normalized note model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeNote(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    title:     d.title   || '',
    content:   d.content || '',
    type:      d.type    || 'text',
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
  };
}

function updatedAtMillis(n) {
  return n.updatedAt?.toMillis?.() ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only
// ─────────────────────────────────────────────────────────────────────────────

async function getAllNotes(uid) {
  try {
    const snap = await db.collection('notes')
      .where('userId', '==', uid)
      .get();
    return snap.docs
      .map(normalizeNote)
      .sort((a, b) => updatedAtMillis(b) - updatedAtMillis(a));
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=notes operation=getAllNotes code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить заметки');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure filter helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterByQuery(notes, q) {
  if (!q) return notes;
  const lc = q.toLowerCase();
  return notes.filter(n =>
    (n.title   || '').toLowerCase().includes(lc) ||
    (n.content || '').toLowerCase().includes(lc)
  );
}

module.exports = {
  getAllNotes,
  filterByQuery,
  normalizeNote,
  updatedAtMillis,
};
