'use strict';

const { db, admin } = require('../firebaseAdmin');
const { getTonRateUsd } = require('./ton-rate');

const COMMISSION_RATE       = 0.15;
const CANCEL_WINDOW_DAYS    = 7;     // cancellation within 7 days → no payout
const ANOMALY_THRESHOLD_DAY = 20;    // flag if referrer brings > N conversions/day

const TG = 'https://api.telegram.org';

async function tgNotify(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`${TG}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('[referral:notify]', err.message));
}

// Called when a subscription payment is successfully processed.
// Creates a referral_earnings doc and updates referrer totals.
async function processSubscriptionPayment(referredUserId, amountUsd, paymentId, telegramToken) {
  // Find referral for this user (pending or converted)
  const refSnap = await db.collection('referrals')
    .where('referredId', '==', referredUserId)
    .where('status', 'in', ['pending', 'converted'])
    .limit(1)
    .get();

  if (refSnap.empty) return null;

  const refDoc  = refSnap.docs[0];
  const referral = refDoc.data();

  // If still 'pending', check if the 30-day link hasn't expired
  if (referral.status === 'pending') {
    const expiresAt = referral.referralLinkExpiresAt?.toDate?.() || new Date(0);
    if (expiresAt < new Date()) return null;
  }

  // Anomaly check: too many conversions from one referrer today
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const todayEarnings = await db.collection('referral_earnings')
    .where('referrerId', '==', referral.referrerId)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .get();
  if (todayEarnings.size >= ANOMALY_THRESHOLD_DAY) {
    console.error('[referral:anomaly] referrerId', referral.referrerId, 'hit daily threshold');
    const adminChatId = process.env.CONTENT_ADMIN_CHAT_ID;
    await tgNotify(telegramToken, adminChatId,
      `⚠️ Антифрод: referrerId <code>${referral.referrerId}</code> — ${todayEarnings.size + 1} конверсий за день. Требует проверки.`
    );
    return null;
  }

  const tonRate       = await getTonRateUsd();
  const commissionUsd = Math.round(amountUsd * COMMISSION_RATE * 100) / 100;
  const commissionTon = Math.round((commissionUsd / tonRate) * 10000) / 10000;

  // Create earnings doc
  const earnRef = await db.collection('referral_earnings').add({
    referrerId:    referral.referrerId,
    referredId:    referredUserId,
    paymentId,
    amountUsd,
    commissionUsd,
    commissionTon,
    tonRateUsd:    tonRate,
    status:        'pending',
    createdAt:     admin.firestore.FieldValue.serverTimestamp(),
    paidAt:        null,
    payoutBatchId: null,
  });

  // Mark referral as converted
  if (referral.status === 'pending') {
    await refDoc.ref.update({
      status:      'converted',
      convertedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Update referrer totals
  await db.collection('users').doc(referral.referrerId).set({
    totalEarningsUsd: admin.firestore.FieldValue.increment(commissionUsd),
    pendingPayoutUsd: admin.firestore.FieldValue.increment(commissionUsd),
  }, { merge: true });

  // Notify referrer
  if (telegramToken) {
    const referrerDoc = await db.collection('users').doc(referral.referrerId).get();
    const referrerChatId = referrerDoc.data()?.chatId;
    if (referrerChatId) {
      const referredDoc = await db.collection('users').doc(referredUserId).get();
      const referredName = referredDoc.data()?.firstName || 'Пользователь';
      await tgNotify(telegramToken, referrerChatId,
        `💰 <b>${referredName}</b> оплатил подписку.\nНачислено <b>$${commissionUsd.toFixed(2)}</b> (≈ ${commissionTon} TON)`
      );
    }
  }

  return { earnId: earnRef.id, commissionUsd, commissionTon };
}

// Called on subscription cancellation / refund.
// Marks recent pending earnings as cancelled.
async function cancelSubscriptionPayment(referredUserId, paymentId, telegramToken) {
  const earningSnap = await db.collection('referral_earnings')
    .where('referredId', '==', referredUserId)
    .where('paymentId', '==', paymentId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (earningSnap.empty) return null;

  const earnDoc = earningSnap.docs[0];
  const earn    = earnDoc.data();

  // Honour the 7-day cancellation window
  const createdAt = earn.createdAt?.toDate?.() || new Date(0);
  const ageMs     = Date.now() - createdAt.getTime();
  if (ageMs < CANCEL_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    await earnDoc.ref.update({
      status:      'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('users').doc(earn.referrerId).set({
      pendingPayoutUsd: admin.firestore.FieldValue.increment(-earn.commissionUsd),
    }, { merge: true });
  }

  // Update referral status
  const refSnap = await db.collection('referrals')
    .where('referrerId', '==', earn.referrerId)
    .where('referredId', '==', referredUserId)
    .limit(1)
    .get();
  if (!refSnap.empty) {
    await refSnap.docs[0].ref.update({
      status:      'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Notify referrer
  if (telegramToken) {
    const referrerDoc = await db.collection('users').doc(earn.referrerId).get();
    const referrerChatId = referrerDoc.data()?.chatId;
    if (referrerChatId) {
      const referredDoc = await db.collection('users').doc(referredUserId).get();
      const referredName = referredDoc.data()?.firstName || 'Пользователь';
      await tgNotify(telegramToken, referrerChatId,
        `⚠️ <b>${referredName}</b> отменил подписку. Выплаты с него прекращены.`
      );
    }
  }

  return { cancelled: true };
}

module.exports = { processSubscriptionPayment, cancelSubscriptionPayment };
