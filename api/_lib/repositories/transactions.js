'use strict';

const { db } = require('../firebaseAdmin');
const { convertCurrency } = require('../convertCurrency');
const { resolveTransactionCurrency } = require('../finance/resolveLegacyCurrency');
const { hasLockedRub } = require('../finance/lockedAmount');

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
    // Currency the amount above is expressed in. Legacy records without this
    // field must be resolved via resolveTransactionCurrency (uses `source` +
    // `createdAt` below) — never guessed as a blanket default here.
    currency:    d.currency || null,
    // Needed by resolveTransactionCurrency for legacy (currency-less) records.
    source:      d.source || null,
    originalAmount:   typeof d.originalAmount === 'number' ? d.originalAmount : undefined,
    originalCurrency: d.originalCurrency || undefined,
    category:    d.category    || d.categoryId || '',
    categoryId:  d.categoryId  || '',
    description: d.description || '',
    bank:        d.bank        || '',
    date:        typeof d.date === 'string' ? d.date : (d.date ? new Date(d.date).toISOString() : ''),
    createdAt:   d.createdAt,
    // schemaVersion 2: locked ruble value + FX snapshot (budget math reads rubAmount)
    ...(d.schemaVersion === 2 ? {
      schemaVersion: 2,
      rubAmount: Number.isFinite(d.rubAmount) ? d.rubAmount : undefined,
      fx: d.fx || null,
    } : {}),
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

// Never sum raw amounts across different currencies, and never guess a
// legacy record's currency as a blanket default — resolveTransactionCurrency
// determines it from proven historical write-path semantics (source +
// createdAt). Each transaction is converted from its own (resolved) currency
// into targetCurrency individually before being added to the balance. A
// transaction whose currency can't be resolved, or can't be converted
// (rates unavailable), is skipped rather than mis-summed — this keeps a
// RUB-only user's balance correct even when the FX API is offline, since
// same-currency transactions never need `rates` at all.
function calculateCurrentBalance(transactions, targetCurrency = 'RUB', rates = null) {
  let balance = 0;
  for (const t of transactions) {
    if (hasLockedRub(t) && targetCurrency === 'RUB') {
      if (t.type === 'income')  balance += t.rubAmount;
      if (t.type === 'expense') balance -= t.rubAmount;
      continue;
    }
    const resolved = resolveTransactionCurrency(t);
    if (resolved.currency === null) continue; // unresolvable — never guessed
    let amount = t.amount;
    if (resolved.currency !== targetCurrency) {
      if (!rates) continue;
      amount = convertCurrency(t.amount, resolved.currency, targetCurrency, rates);
    }
    if (t.type === 'income')  balance += amount;
    if (t.type === 'expense') balance -= amount;
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
