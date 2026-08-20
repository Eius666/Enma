'use strict';

const { db, admin } = require('../firebaseAdmin');

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

// Idempotently record that userId came via influencer code.
// Writes users/{uid}.referredByInfluencer and referrals/{uid}_{code}.
async function recordInfluencerReferral(userId, code) {
  const codeUpper = code.toUpperCase();

  const userSnap = await db.collection('users').doc(userId).get();
  if (userSnap.exists && userSnap.data().referredByInfluencer) return;

  await Promise.all([
    db.collection('users').doc(userId).set(
      { referredByInfluencer: codeUpper },
      { merge: true }
    ),
    db.collection('referrals').doc(`${userId}_${codeUpper}`).set({
      referrerId: codeUpper,
      userId,
      code: codeUpper,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);
}

// Called after a payment is confirmed.
// amountRub: actual paid amount in rubles (after all discounts applied).
// Returns { commission, earnId } or null.
async function processInfluencerCommission(userId, code, amountRub, subscriptionId) {
  if (!code) return null;
  const codeUpper = code.toUpperCase();

  const referrerRef  = db.collection('referrers').doc(codeUpper);
  const referrerSnap = await referrerRef.get();
  if (!referrerSnap.exists) return null;

  const referrer = referrerSnap.data();
  if (referrer.status !== 'active') return null;

  const commissionPercent = referrer.commissionPercent ?? 30;
  const commission = Math.round(amountRub * commissionPercent) / 100;

  await recordInfluencerReferral(userId, codeUpper);

  const earnRef = db.collection('referralEarnings').doc();

  await db.runTransaction(async tx => {
    tx.set(earnRef, {
      id:             earnRef.id,
      referrerId:     codeUpper,
      userId,
      subscriptionId,
      amount:         amountRub,
      commission,
      status:         'pending',
      createdAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(referrerRef, {
      totalEarned:   admin.firestore.FieldValue.increment(commission),
      pendingPayout: admin.firestore.FieldValue.increment(commission),
    });
  });

  return { commission, earnId: earnRef.id };
}

module.exports = { validateInfluencerCode, recordInfluencerReferral, processInfluencerCommission };
