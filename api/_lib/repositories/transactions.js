'use strict';

const { db } = require('../firebaseAdmin');

// ─────────────────────────────────────────────────────────────────────────────
// Shared sort helpers (pure, exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

function sortByDateDesc(a, b) {
  const dA = a.date || '';
  const dB = b.date || '';
  return dB > dA ? 1 : dB < dA ? -1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized transaction model
// ─────────────────────────────────────────────────────────────────────────────

function normalizeTransaction(doc) {
  const d  = typeof doc.data === 'function' ? doc.data() : doc;
  const id = doc.id || d.id || '';
  return {
    id,
    type:        d.type,
    amount:      typeof d.amount === 'number' ? d.amount : 0,
    category:    d.category    || d.categoryId || '',
    categoryId:  d.categoryId  || '',
    description: d.description || '',
    bank:        d.bank        || '',
    date:        typeof d.date === 'string' ? d.date : (d.date ? new Date(d.date).toISOString() : ''),
    createdAt:   d.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore reads — single-field filter only (no composite index required)
// ─────────────────────────────────────────────────────────────────────────────

async function getAllTransactions(uid) {
  try {
    const snap = await db.collection('transactions')
      .where('userId', '==', uid)
      .get();
    return snap.docs
      .map(normalizeTransaction)
      .sort(sortByDateDesc);
  } catch (err) {
    console.error('[DATA_REPOSITORY_ERROR] repository=transactions operation=getAllTransactions code=%s', err.code || 'UNKNOWN');
    const e = new Error('Не удалось загрузить транзакции');
    e.code  = 'DATA_UNAVAILABLE';
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure computation helpers — no Firestore calls
// ─────────────────────────────────────────────────────────────────────────────

function calculateCurrentBalance(transactions) {
  let balance = 0;
  for (const t of transactions) {
    if (t.type === 'income')  balance += t.amount;
    if (t.type === 'expense') balance -= t.amount;
  }
  return Math.round(balance * 100) / 100;
}

function filterByPeriod(transactions, from, to) {
  return transactions.filter(t => {
    const d = (t.date || '').slice(0, 10);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
}

function filterByType(transactions, type) {
  if (!type || type === 'all') return transactions;
  return transactions.filter(t => t.type === type);
}

function filterByQuery(transactions, q) {
  if (!q) return transactions;
  const lc = q.toLowerCase();
  return transactions.filter(t =>
    (t.description || '').toLowerCase().includes(lc) ||
    (t.category    || '').toLowerCase().includes(lc)
  );
}

function getRecentTransactions(transactions, limit = 15) {
  return transactions.slice(0, limit);
}

module.exports = {
  getAllTransactions,
  calculateCurrentBalance,
  filterByPeriod,
  filterByType,
  filterByQuery,
  getRecentTransactions,
  normalizeTransaction,
  sortByDateDesc,
};
