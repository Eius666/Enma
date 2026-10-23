'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Normalized task model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTask(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    title:       d.title       || '',
    description: d.description || '',
    date:        d.date        || '',
    time:        d.time        || '',
    priority:    d.priority    || 'medium',
    completed:   Boolean(d.completed || d.done),
    createdAt:   d.createdAt,
    updatedAt:   d.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only
// ─────────────────────────────────────────────────────────────────────────────

async function getAllTasks(uid) {
  try {
    const snap = await db.collection('tasks')
      .where('userId', '==', uid)
      .get();
    return snap.docs
      .map(normalizeTask)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=tasks operation=getAllTasks code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить задачи');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

module.exports = {
  getAllTasks,
  normalizeTask,
};
