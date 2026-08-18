'use strict';

const { db, admin } = require('./firebaseAdmin');

const PLATEGA_BASE  = 'https://app.platega.io';
const APP_URL       = process.env.REACT_APP_URL || 'https://enma-silk.vercel.app';
const BASE_PRICE    = 1000;

/**
 * @param {object} opts
 * @param {string}  opts.userId
 * @param {number}  opts.finalAmount       — amount actually charged (after promo)
 * @param {string}  [opts.userName]
 * @param {number}  [opts.originalAmount]  — base price before discount
 * @param {number}  [opts.discountPercent] — 0 if no promo
 * @param {string}  [opts.promoCode]       — promo code string or null
 */
async function createSbpPayment({ userId, finalAmount, userName = '', originalAmount, discountPercent = 0, promoCode = null }) {
  const merchantId = process.env.PLATEGA_MERCHANT_ID;
  const secret     = process.env.PLATEGA_SECRET;
  if (!merchantId || !secret) throw new Error('PLATEGA credentials not configured');

  const payload = `enma_sub_${userId}_${Date.now()}`;
  const amount  = parseFloat(finalAmount.toFixed(2));

  const resp = await fetch(`${PLATEGA_BASE}/transaction/process`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MerchantId': merchantId,
      'X-Secret':     secret,
    },
    body: JSON.stringify({
      paymentMethod:  2,
      paymentDetails: { amount, currency: 'RUB' },
      description:    `Enma Pro — ${userName || 'пользователь'}`,
      return:         APP_URL,
      failedUrl:      APP_URL,
      payload,
      metadata:       { userId, userName },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Platega ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const { transactionId, redirect, expiresIn, status } = data;

  const paymentDoc = {
    transactionId,
    userId,
    amount,
    originalAmount: originalAmount ?? amount,
    currency:       'RUB',
    method:         'sbp',
    status:         status || 'PENDING',
    payload,
    confirmedAt:    null,
    createdAt:      admin.firestore.FieldValue.serverTimestamp(),
  };
  if (discountPercent) paymentDoc.discountPercent = discountPercent;
  if (promoCode)       paymentDoc.promoCode       = promoCode;

  await db.collection('payments').add(paymentDoc);

  return { url: redirect, transactionId, expiresIn };
}

async function getSbpPaymentStatus(transactionId, userId) {
  const snap = await db.collection('payments')
    .where('transactionId', '==', transactionId)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const d = snap.docs[0].data();
  return { status: d.status, amount: d.amount, originalAmount: d.originalAmount };
}

module.exports = { createSbpPayment, getSbpPaymentStatus, BASE_PRICE };
