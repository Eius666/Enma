'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Normalized reminder model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeReminder(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    title:       d.title  || '',
    notes:       d.notes  || '',
    status:      d.status ?? (d.done ? 'done' : 'pending'),
    date:        d.date   || '',
    time:        d.time   || '',
    scheduledAt: d.scheduledAt,   // Firestore Timestamp — callers use .toDate()/.toMillis()
    createdAt:   d.createdAt,
    updatedAt:   d.updatedAt,
  };
}

function scheduledAtMillis(r) {
  return r.scheduledAt?.toMillis?.() ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only
// ─────────────────────────────────────────────────────────────────────────────

async function getAllReminders(uid) {
  try {
    const snap = await db.collection('reminders')
      .where('userId', '==', uid)
      .get();
    return snap.docs
      .map(normalizeReminder)
      .sort((a, b) => scheduledAtMillis(a) - scheduledAtMillis(b));
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=reminders operation=getAllReminders code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить напоминания');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure filter helpers
// ─────────────────────────────────────────────────────────────────────────────

function filterPending(reminders) {
  return reminders.filter(r => r.status === 'pending');
}

function filterByStatus(reminders, status) {
  if (status === 'all') return reminders;
  return reminders.filter(r => r.status === status);
}

function filterByDateRange(reminders, from, to) {
  return reminders.filter(r => {
    const d = r.date || '';
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

module.exports = {
  getAllReminders,
  filterPending,
  filterByStatus,
  filterByDateRange,
  normalizeReminder,
  scheduledAtMillis,
};
