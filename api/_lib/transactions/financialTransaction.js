'use strict';

// ── Unified financial transaction service ────────────────────────────────────
//
// The ONLY place where a new transaction's money fields are decided. Web UI
// (/api/ai/entityCreate + transactionUpdate) and Telegram (tools.js) both go
// through here, so currency semantics can never drift between channels again.
//
// Contract (schemaVersion 2):
//   amount     — what the user actually spent/received, in `currency`
//   currency   — the operation's real currency
//   rubAmount  — ruble equivalent, LOCKED at creation time
//   fx         — the snapshot used (null for RUB): rateToRub, source, provider,
//                capturedAt, method, sampleSize, rateSide, rateDate
//
// Currency precedence: explicit currency → user.currency → RUB.
//   user.currency = "the currency the user currently enters new operations in".
//   It is NOT the budget currency (always RUB) and never rewrites history.
//
// Trust boundary: clients may send amount/currency, never rubAmount/fx — this
// module ignores any such fields and asks the FX service itself.
//
// If a foreign transaction needs FX and no reliable rate exists, the
// transaction is NOT written (FxUnavailableError). RUB never touches FX.

const { HOME_BUDGET_CURRENCY } = require('../config');
const { resolveTransactionCurrency } = require('../finance/resolveLegacyCurrency');

const TRANSACTION_CURRENCIES = new Set([
  'RUB', 'USD', 'EUR', 'CNY', 'BYN', 'GBP', 'KZT', 'TRY', 'AED', 'JPY', 'CHF',
]);
const MAX_AMOUNT = 1_000_000_000;

class TransactionValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'TransactionValidationError';
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

function isSupportedCurrency(c) {
  return typeof c === 'string' && TRANSACTION_CURRENCIES.has(c);
}

// explicit → user.currency → RUB. Unsupported/garbage values fall through to
// the next level instead of being stored.
function resolveOperationCurrency({ explicit, userCurrency } = {}) {
  if (isSupportedCurrency(explicit)) return explicit;
  if (isSupportedCurrency(userCurrency)) return userCurrency;
  return HOME_BUDGET_CURRENCY;
}

async function readUserCurrency(db, uid) {
  try {
    const snap = await db.collection('users').doc(uid).get();
    const c = snap.exists ? snap.data().currency : null;
    return isSupportedCurrency(c) ? c : null;
  } catch {
    return null;
  }
}

function validateMoney({ type, amount }) {
  if (!['income', 'expense'].includes(type)) {
    throw new TransactionValidationError('VALIDATION_ERROR', 'type must be "income" or "expense"');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new TransactionValidationError('VALIDATION_ERROR', 'amount must be a positive number');
  }
  if (amount > MAX_AMOUNT) {
    throw new TransactionValidationError('VALIDATION_ERROR', 'amount is too large');
  }
}

function fxBlock(snapshot) {
  const block = {
    rateToRub:  snapshot.rateToRub,
    source:     snapshot.source,
    provider:   snapshot.provider,
    capturedAt: snapshot.capturedAt,
    method:     snapshot.method,
    rateSide:   snapshot.rateSide,
    rateDate:   snapshot.rateDate,
  };
  if (snapshot.sampleSize != null)            block.sampleSize = snapshot.sampleSize;
  if (snapshot.requestedDate)                 block.requestedDate = snapshot.requestedDate;
  if (snapshot.rateMatchesRequestedDate != null) block.rateMatchesRequestedDate = snapshot.rateMatchesRequestedDate;
  return block;
}

// Captures the money fields for (amount, currency): RUB is identity with no
// FX call at all; anything else locks a bank-rate snapshot.
async function captureMoney({ type, amount, currency, date }, fx) {
  if (currency === HOME_BUDGET_CURRENCY) {
    return { amount: round2(amount), currency, rubAmount: round2(amount), fx: null };
  }
  const snapshot = await fx.getBankRateToRub({ currency, transactionType: type, timestamp: date });
  return {
    amount:    round2(amount),
    currency,
    rubAmount: round2(amount * snapshot.rateToRub),
    fx:        fxBlock(snapshot),
  };
}

function defaultFx() {
  return require('../fx');
}

// Pure-ish builder (only the FX lookup is async). No Firestore.
async function buildFinancialTransaction(input, { fx } = {}) {
  const {
    type, amount, currency: explicitCurrency, userCurrency,
    description = '', date, categoryId, category, bank, goalId, source,
  } = input;

  validateMoney({ type, amount });

  const currency = resolveOperationCurrency({ explicit: explicitCurrency, userCurrency });
  const isoDate  = date || new Date().toISOString();
  const money    = await captureMoney({ type, amount, currency, date: isoDate }, fx || defaultFx());

  const doc = {
    schemaVersion: 2,
    type,
    ...money,
    description: String(description || '').trim().slice(0, 200),
    date:        isoDate,
  };
  if (categoryId !== undefined) doc.categoryId = categoryId;
  if (category   !== undefined) doc.category   = category;
  if (bank)   doc.bank   = String(bank).slice(0, 100);
  if (goalId) doc.goalId = goalId;
  if (source) doc.source = source;
  return doc;
}

// Default persistence: direct write. Web AI / Web UI pass a persist function
// that adds the free-plan limit transaction instead.
function makeDefaultPersist(db, admin) {
  return async (uid, doc, id) => {
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('transactions').doc(id).set({ ...doc, userId: uid, createdAt: now, updatedAt: now });
    return { ok: true, id };
  };
}

function newId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// The single entry point for creating a transaction.
//   uid          — verified owner
//   docId        — optional deterministic id (idempotent retries)
//   userCurrency — optional; read from the profile when omitted
async function createFinancialTransaction(input, deps = {}) {
  const { db, admin } = deps.firebase || require('../firebaseAdmin');
  const persist = deps.persist || makeDefaultPersist(db, admin);
  const { uid, docId, extra = {} } = input;

  const id = docId || newId();

  // Idempotency: a retry of the same logical operation must not create a
  // second document and must not take a second (possibly different) FX
  // snapshot — the first successful snapshot is canonical.
  if (docId) {
    const existing = await db.collection('transactions').doc(String(docId)).get();
    if (existing.exists) {
      return { ok: true, id: String(docId), duplicate: true, transaction: existing.data() };
    }
  }

  const userCurrency = input.userCurrency !== undefined
    ? input.userCurrency
    : await readUserCurrency(db, uid);

  const doc = await buildFinancialTransaction({ ...input, userCurrency }, { fx: deps.fx });
  Object.assign(doc, extra);

  const result = await persist(uid, doc, id);
  if (!result || result.ok === false) return { ...result, ok: false };
  return { ok: true, id: result.id || id, transaction: doc };
}

// Edit semantics:
//   • description/category/bank/date only → money fields untouched
//   • same currency, new amount           → rubAmount = new amount × ORIGINAL rate
//   • different currency                   → new FX snapshot
// Legacy (no rubAmount) transactions edited without money changes stay legacy.
async function buildTransactionUpdate({ existing, patch, userCurrency }, { fx } = {}) {
  const updates = {};
  const passthrough = ['description', 'categoryId', 'category', 'bank', 'date'];
  for (const k of passthrough) {
    if (patch[k] !== undefined) updates[k] = k === 'description' ? String(patch[k] || '').trim().slice(0, 200) : patch[k];
  }

  const isV2 = existing.schemaVersion === 2 && Number.isFinite(existing.rubAmount);
  const existingCurrency = isV2 ? existing.currency : resolveTransactionCurrency(existing).currency;
  const existingType = existing.type;

  const nextType     = patch.type !== undefined ? patch.type : existingType;
  const nextAmount   = patch.amount !== undefined ? patch.amount : existing.amount;
  const nextCurrency = patch.currency !== undefined
    ? resolveOperationCurrency({ explicit: patch.currency, userCurrency })
    : existingCurrency;

  const amountChanged   = patch.amount !== undefined && round2(patch.amount) !== round2(existing.amount);
  const currencyChanged = patch.currency !== undefined && nextCurrency !== existingCurrency;
  const typeChanged     = patch.type !== undefined && nextType !== existingType;

  if (typeChanged) updates.type = nextType;

  if (!amountChanged && !currencyChanged) return updates;

  validateMoney({ type: nextType, amount: nextAmount });
  const currency = nextCurrency || resolveOperationCurrency({ userCurrency });

  if (isV2 && !currencyChanged && currency !== HOME_BUDGET_CURRENCY && existing.fx && existing.fx.rateToRub > 0) {
    // Same operation, corrected amount → keep the original snapshot.
    updates.amount    = round2(nextAmount);
    updates.rubAmount = round2(nextAmount * existing.fx.rateToRub);
    return updates;
  }

  const money = await captureMoney({ type: nextType, amount: nextAmount, currency, date: updates.date || existing.date }, fx || defaultFx());
  Object.assign(updates, money, { schemaVersion: 2 });
  return updates;
}

module.exports = {
  createFinancialTransaction,
  buildFinancialTransaction,
  buildTransactionUpdate,
  resolveOperationCurrency,
  isSupportedCurrency,
  TRANSACTION_CURRENCIES,
  TransactionValidationError,
};
