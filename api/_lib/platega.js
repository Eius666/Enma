'use strict';

const { db, admin } = require('./firebaseAdmin');

const PLATEGA_BASE = 'https://app.platega.io';
const APP_URL = process.env.REACT_APP_URL || 'https://enma-silk.vercel.app';

async function createSbpPayment(userId, amount, userName = '') {
  const merchantId = process.env.PLATEGA_MERCHANT_ID;
  const secret     = process.env.PLATEGA_SECRET;
  if (!merchantId || !secret) throw new Error('PLATEGA credentials not configured');

  const payload = `enma_sub_${userId}_${Date.now()}`;

  const resp = await fetch(`${PLATEGA_BASE}/transaction/process`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MerchantId': merchantId,
      'X-Secret':     secret,
    },
    body: JSON.stringify({
      paymentMethod:  2,
      paymentDetails: { amount: Number(amount), currency: 'RUB' },
      description:    `Enma Pro — ${userName || `пользователь`}`,
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

  await db.collection('payments').add({
    transactionId,
    userId,
    amount:    Number(amount),
    currency:  'RUB',
    method:    'sbp',
    status:    status || 'PENDING',
    payload,
    confirmedAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { url: redirect, transactionId, expiresIn };
}

async function getSbpPaymentStatus(transactionId, userId) {
  const snap = await db.collection('payments')
    .where('transactionId', '==', transactionId)
    .where('userId', '==', userId)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const data = snap.docs[0].data();
  return { status: data.status, amount: data.amount };
}

module.exports = { createSbpPayment, getSbpPaymentStatus };
