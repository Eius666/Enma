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

// ─────────────────────────────────────────────────────────────────────────────
// Pure filter helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterToday(tasks, today) {
  return tasks.filter(t => t.date === today);
}

function filterUpcoming(tasks, today) {
  return tasks.filter(t => t.date > today);
}

function filterByStatus(tasks, status) {
  if (status === 'completed') return tasks.filter(t =>  t.completed);
  if (status === 'pending')   return tasks.filter(t => !t.completed);
  return tasks;
}

function filterByQuery(tasks, q) {
  if (!q) return tasks;
  const lc = q.toLowerCase();
  return tasks.filter(t =>
    (t.title       || '').toLowerCase().includes(lc) ||
    (t.description || '').toLowerCase().includes(lc)
  );
}

function filterByDateRange(tasks, from, to) {
  return tasks.filter(t => {
    const d = t.date || '';
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

module.exports = {
  getAllTasks,
  filterToday,
  filterUpcoming,
  filterByStatus,
  filterByQuery,
  filterByDateRange,
  normalizeTask,
};
