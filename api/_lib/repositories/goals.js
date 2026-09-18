'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Normalized goal model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeGoal(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    title:         d.title         || '',
    targetAmount:  d.targetAmount  || 0,
    currentAmount: d.currentAmount || 0,
    deadline:      d.deadline      || '',
    createdAt:     d.createdAt,
    updatedAt:     d.updatedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only
// ─────────────────────────────────────────────────────────────────────────────

async function getAllGoals(uid) {
  try {
    const snap = await db.collection('goals')
      .where('userId', '==', uid)
      .get();
    return snap.docs.map(normalizeGoal);
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=goals operation=getAllGoals code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить цели');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

module.exports = {
  getAllGoals,
  normalizeGoal,
};
