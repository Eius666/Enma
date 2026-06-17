'use strict';

const { admin, db } = require('../firebaseAdmin');

const BASE_CURRENCY = 'USD';
const RATES_TTL_MS  = 60 * 60 * 1000;

let ratesCache = { rates: { USD: 1 }, fetchedAt: 0 };

async function getExchangeRates() {
  if (ratesCache.fetchedAt && Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) {
    return ratesCache.rates;
  }
  try {
    const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`);
    if (!resp.ok) throw new Error(`rates API returned ${resp.status}`);
    const data = await resp.json();
    const rates = { USD: 1 };
    for (const [c, r] of Object.entries(data.rates)) rates[c] = r;
    ratesCache = { rates, fetchedAt: Date.now() };
    return rates;
  } catch (err) {
    console.error('[saveTransaction] Failed to fetch exchange rates:', err.message);
    return ratesCache.rates;
  }
}

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const VALID_TYPES = new Set(['expense', 'income']);

/**
 * Save a transaction extracted from an AI marker to Firestore.
 *
 * @param {string} userId
 * @param {{ amount: number, type: string, category: string, currency: string }} txn
 * @returns {Promise<object>} The saved document data
 */
async function saveTransaction(userId, { amount, type, category, currency }) {
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error(`[saveTransaction] Invalid amount: ${amount}`);
  }
  const txnType = VALID_TYPES.has(type) ? type : 'expense';

  const rates        = await getExchangeRates();
  const rate         = rates[currency] || 1;
  const amountInBase = currency === BASE_CURRENCY ? numAmount : numAmount / rate;

  const id  = createId();
  const doc = {
    id,
    userId,
    type:             txnType,
    amount:           amountInBase,
    originalAmount:   numAmount,
    originalCurrency: currency,
    categoryId:       'cat-default',
    description:      String(category || '').slice(0, 500),
    date:             new Date().toISOString(),
    updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
    source:           'telegram-bot',
  };

  await db.collection('transactions').doc(id).set(doc);
  console.log('[saveTransaction] saved:', id, txnType, numAmount, currency, 'for user:', userId);
  return doc;
}

module.exports = { saveTransaction };
