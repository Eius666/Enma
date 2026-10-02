'use strict';

const { db, admin } = require('../firebaseAdmin');

const ANOMALY_THRESHOLD_DAY = 20; // flag if a partner brings > N conversions/day
const CANCEL_WINDOW_DAYS    = 7;  // cancellation within 7 days -> commission clawed back
const DEFAULT_PLATFORM      = 'direct';

const TG = 'https://api.telegram.org';
async function tgNotify(token, chatId, text) {
  if (!token || !chatId) return;
  await fetch(`${TG}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch((err) => console.error('[influencer:notify]', err.message));
}

// Validate influencer referral code.
// userId is optional — when provided, checks if user already has a different referrer.
async function validateInfluencerCode(code, userId) {
  const codeUpper = code.trim().toUpperCase();
  const snap = await db.collection('referrers').doc(codeUpper).get();

  if (!snap.exists) return { valid: false, error: 'referral_not_found' };

  const referrer = snap.data();
  if (referrer.status !== 'active') return { valid: false, error: 'referral_inactive' };

  if (userId) {
    const userSnap = await db.collection('users').doc(userId).get();
    if (userSnap.exists) {
      const existing = userSnap.data().referredByInfluencer;
      // Already referred by a different influencer — block
      if (existing && existing !== codeUpper) {
        return { valid: false, error: 'already_referred' };
      }
    }
  }

  return {
    valid:             true,
    code:              codeUpper,
    discountPercent:   referrer.discountPercent   ?? 10,
    commissionPercent: referrer.commissionPercent ?? 30,
    referrerName:      referrer.name              ?? '',
  };
}

// Idempotently record that userId came via influencer code. Writes
// users/{uid}.referredByInfluencer(+Platform) and referrals/{uid}_{code}, and
// bumps the referrer's (and, if platform is known, the per-link) registration
// counter — but only on the FIRST call for this user, so re-visits and the
// checkout-time call (which has no platform) never double-count.
// Returns true if this call recorded a NEW attribution, false if the user was
// already attributed to this (or another) partner.
async function recordInfluencerReferral(userId, code, platform) {
  const codeUpper = code.toUpperCase();
  const p = platform || DEFAULT_PLATFORM;

  const userRef  = db.collection('users').doc(userId);
  const userSnap = await userRef.get();
  if (userSnap.exists && userSnap.data().referredByInfluencer) return false;

  const referrerRef = db.collection('referrers').doc(codeUpper);
  const linkRef      = referrerRef.collection('links').doc(p);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    tx.set(userRef, { referredByInfluencer: codeUpper, referredByInfluencerPlatform: p }, { merge: true });
    tx.set(db.collection('referrals').doc(`${userId}_${codeUpper}`), {
      referrerId: codeUpper, userId, code: codeUpper, platform: p, createdAt: now,
    }, { merge: true });
    tx.set(referrerRef, { registrations: admin.firestore.FieldValue.increment(1) }, { merge: true });
    tx.set(linkRef, { platform: p, registrations: admin.firestore.FieldValue.increment(1) }, { merge: true });
  });
  return true;
}

// A partner can never earn commission on their own payments. Compares the
// payer's Telegram identity to the partner's linked Telegram identity —
// admin-created partners with no linked Telegram account simply never match.
async function isSelfReferral(referrer, payerUserId) {
  if (!referrer.telegramId) return false;
  const payerSnap = await db.collection('users').doc(payerUserId).get();
  if (!payerSnap.exists) return false;
  const payer = payerSnap.data();
  const payerTelegramId = payer.telegramId ?? payer.chatId ?? null;
  return payerTelegramId != null && Number(payerTelegramId) === Number(referrer.telegramId);
}

// Called after a payment is confirmed.
// amountRub: actual paid amount in rubles (after all discounts applied).
// Returns { commission, earnId } or null (no commission recorded — reason is
// logged, never thrown: a commission bug must never block a real payment).
async function processInfluencerCommission(userId, code, amountRub, subscriptionId, telegramToken) {
  if (!code) return null;
  const codeUpper = code.toUpperCase();

  const referrerRef  = db.collection('referrers').doc(codeUpper);
  const referrerSnap = await referrerRef.get();
  if (!referrerSnap.exists) return null;

  const referrer = referrerSnap.data();
  if (referrer.status !== 'active') return null;

  if (await isSelfReferral(referrer, userId)) {
    console.warn('[influencer:fraud] self-referral blocked', { code: codeUpper, userId });
    return null;
  }

  // Anti-fraud: too many conversions from one partner in a single day.
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const todayEarnings = await db.collection('referralEarnings')
    .where('referrerId', '==', codeUpper)
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
    .get();
  if (todayEarnings.size >= ANOMALY_THRESHOLD_DAY) {
    console.error('[influencer:anomaly] referrerId', codeUpper, 'hit daily threshold');
    await tgNotify(telegramToken, process.env.CONTENT_ADMIN_CHAT_ID,
      `⚠️ Антифрод: партнёр <code>${codeUpper}</code> — ${todayEarnings.size + 1} конверсий за день. Требует проверки.`);
    return null;
  }

  const commissionPercent = referrer.commissionPercent ?? 30;
  const commission = Math.round(amountRub * commissionPercent) / 100;

  const userSnap = await db.collection('users').doc(userId).get();
  const platform = userSnap.exists ? (userSnap.data().referredByInfluencerPlatform || DEFAULT_PLATFORM) : DEFAULT_PLATFORM;

  await recordInfluencerReferral(userId, codeUpper, platform);

  // Idempotency: one commission per payment, ever. Keyed deterministically by
  // subscriptionId (the payment/transaction id) instead of a random doc id,
  // so a duplicate webhook delivery or an accidental double-call can never
  // create a second commission for the same payment — the transaction reads
  // this exact doc first and no-ops if it already exists.
  const earnId  = subscriptionId ? `pay_${subscriptionId}` : db.collection('referralEarnings').doc().id;
  const earnRef = db.collection('referralEarnings').doc(earnId);
  const linkRef = referrerRef.collection('links').doc(platform);

  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(earnRef);
    if (existing.exists) return null; // already processed this exact payment

    tx.set(earnRef, {
      id:             earnRef.id,
      referrerId:     codeUpper,
      userId,
      subscriptionId,
      amount:         amountRub,
      commission,
      platform,
      status:         'pending',
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(referrerRef, {
      totalEarned:   admin.firestore.FieldValue.increment(commission),
      pendingPayout: admin.firestore.FieldValue.increment(commission),
    }, { merge: true });
    tx.set(linkRef, {
      platform,
      payments:   admin.firestore.FieldValue.increment(1),
      commission: admin.firestore.FieldValue.increment(commission),
    }, { merge: true });
    return { commission, earnId: earnRef.id };
  });

  return result;
}

// Called on subscription cancellation / refund within the SBP payment flow.
// Claws back the commission (and the per-link tally) if still within the
// cancellation window; leaves it alone otherwise — a partner who brought a
// customer that stayed a week keeps the commission even if they cancel later.
async function cancelInfluencerCommission(userId, subscriptionId) {
  const snap = await db.collection('referralEarnings')
    .where('userId', '==', userId)
    .where('subscriptionId', '==', subscriptionId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();
  if (snap.empty) return null;

  const earnDoc = snap.docs[0];
  const earn = earnDoc.data();
  const createdAt = earn.createdAt?.toDate?.() || new Date(0);
  const ageMs = Date.now() - createdAt.getTime();
  if (ageMs >= CANCEL_WINDOW_DAYS * 24 * 60 * 60 * 1000) return { withinWindow: false };

  const referrerRef = db.collection('referrers').doc(earn.referrerId);
  const linkRef = referrerRef.collection('links').doc(earn.platform || DEFAULT_PLATFORM);

  await db.runTransaction(async (tx) => {
    tx.update(earnDoc.ref, { status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(referrerRef, { pendingPayout: admin.firestore.FieldValue.increment(-earn.commission) }, { merge: true });
    tx.set(linkRef, { commission: admin.firestore.FieldValue.increment(-earn.commission) }, { merge: true });
  });

  return { withinWindow: true, clawedBack: earn.commission };
}

module.exports = {
  validateInfluencerCode,
  recordInfluencerReferral,
  processInfluencerCommission,
  cancelInfluencerCommission,
};
