'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Normalized habit model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHabit(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    title:          d.title          || '',
    repeatType:     d.repeatType     || 'daily',
    completedDates: Array.isArray(d.completedDates) ? d.completedDates : [],
    streak:         d.streak         ?? 0,
    archived:       d.archived       ?? false,
    createdAt:      d.createdAt,
    updatedAt:      d.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only
// ─────────────────────────────────────────────────────────────────────────────

async function getAllHabits(uid) {
  try {
    const snap = await db.collection('habits')
      .where('userId', '==', uid)
      .get();
    return snap.docs.map(normalizeHabit);
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=habits operation=getAllHabits code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить привычки');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure filter helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterActive(habits) {
  return habits.filter(h => !h.archived);
}

function isCompletedToday(habit, today) {
  return habit.completedDates.includes(today);
}

module.exports = {
  getAllHabits,
  filterActive,
  isCompletedToday,
  normalizeHabit,
};
