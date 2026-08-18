'use strict';

const { db, admin }           = require('../_lib/firebaseAdmin');
const { incrementPromoUsage } = require('../_lib/promoCodes');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function notifyUser(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('[callback] notify error:', err.message));
}

module.exports = async function handler(req, res) {
  // Always 200 to prevent Platega retry storm
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const merchantId = process.env.PLATEGA_MERCHANT_ID;
    const secret     = process.env.PLATEGA_SECRET;

    const incomingMerchant = req.headers['x-merchantid'] || req.headers['x-merchantId'];
    const incomingSecret   = req.headers['x-secret'];

    if (incomingMerchant !== merchantId || incomingSecret !== secret) {
      console.warn('[payment/callback] invalid credentials in headers');
      return res.status(200).json({ ok: true });
    }

    const { id: transactionId, amount, status } = req.body || {};
    if (!transactionId || !status) return res.status(200).json({ ok: true });

    const snap = await db.collection('payments')
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn('[payment/callback] unknown transactionId:', transactionId);
      return res.status(200).json({ ok: true });
    }

    const payDoc  = snap.docs[0];
    const payment = payDoc.data();

    if (status === 'CANCELED') {
      await payDoc.ref.update({ status: 'CANCELED' });
      return res.status(200).json({ ok: true });
    }

    if (status === 'CONFIRMED') {
      // Idempotency guard
      if (payment.status === 'CONFIRMED') {
        return res.status(200).json({ ok: true });
      }

      const now        = admin.firestore.FieldValue.serverTimestamp();
      const plan       = payment.plan   || 'pro';
      const period     = payment.period || 'month';
      const periodDays = period === 'year' ? 365 : 30;
      const startDate  = new Date().toISOString();
      const endDate    = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000).toISOString();
      const paidAmount = amount || payment.amount;

      console.log(`[callback] CONFIRMED userId=${payment.userId} plan=${plan} period=${period} endDate=${endDate}`);

      await payDoc.ref.update({ status: 'CONFIRMED', confirmedAt: now });
      console.log(`[callback] payment doc updated`);

      await db.collection('subscriptions').doc(payment.userId).set({
        userId:        payment.userId,
        plan,
        period,
        status:        'active',
        startDate,
        endDate,
        paymentId:     transactionId,
        paymentMethod: 'sbp',
        amountRub:     paidAmount,
        updatedAt:     now,
      }, { merge: true });
      console.log(`[callback] subscriptions/${payment.userId} updated`);

      const subSnapshot = {
        plan,
        period,
        status:        'active',
        startDate,
        endDate,
        paymentMethod: 'sbp',
        userId:        payment.userId,
        updatedAt:     startDate,
      };

      await db.collection('users').doc(payment.userId).set(
        {
          balance:      admin.firestore.FieldValue.increment(paidAmount),
          isPro:        true,
          subscription: subSnapshot,
          updatedAt:    now,
        },
        { merge: true }
      );
      console.log(`[callback] users/${payment.userId} isPro=true written`);

      // Increment promo usedCount atomically
      if (payment.promoCode) {
        await incrementPromoUsage(payment.promoCode).catch(err =>
          console.error('[callback] promo increment error:', err.message)
        );
      }

      const userSnap = await db.collection('users').doc(payment.userId).get();
      const chatId   = userSnap.exists ? userSnap.data().chatId : null;

      const amountText = payment.discountPercent
        ? `${paidAmount} ₽ (скидка ${payment.discountPercent}%)`
        : `${paidAmount} ₽`;

      const durationLabel = period === 'year' ? '1 год' : '30 дней';
      await notifyUser(chatId,
        `✅ Платёж на <b>${amountText}</b> подтверждён!\n\n` +
        `Enma ${plan === 'business' ? 'Business' : 'Pro'} активна на ${durationLabel} 🎉`
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[payment/callback] error:', err.message);
    return res.status(200).json({ ok: true });
  }
};
