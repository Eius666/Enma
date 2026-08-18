'use strict';

const { db, admin } = require('./firebaseAdmin');

const SEED_CODES = {
  ENMATECH90: { discountPercent: 90, maxUses: 100 },
};

async function _ensureSeedCode(codeUpper) {
  const seed = SEED_CODES[codeUpper];
  if (!seed) return;
  const ref = db.collection('promoCodes').doc(codeUpper);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        code:            codeUpper,
        discountPercent: seed.discountPercent,
        maxUses:         seed.maxUses,
        usedCount:       0,
        active:          true,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  });
}

async function validatePromoCode(code) {
  const codeUpper = code.trim().toUpperCase();
  await _ensureSeedCode(codeUpper);

  const snap = await db.collection('promoCodes').doc(codeUpper).get();
  if (!snap.exists) return { valid: false, error: 'not_found' };

  const promo = snap.data();
  if (!promo.active) return { valid: false, error: 'inactive' };
  if (promo.maxUses !== null && promo.maxUses !== undefined && promo.usedCount >= promo.maxUses) {
    return { valid: false, error: 'exhausted' };
  }

  return { valid: true, code: codeUpper, discountPercent: promo.discountPercent };
}

async function applyPromoToUser(userId, code) {
  await db.collection('users').doc(userId).set(
    { promoCode: code.toUpperCase() },
    { merge: true }
  );
}

async function getUserPromo(userId) {
  const userSnap = await db.collection('users').doc(userId).get();
  if (!userSnap.exists) return null;
  const code = userSnap.data().promoCode;
  if (!code) return null;

  const result = await validatePromoCode(code);
  if (!result.valid) return null;
  return { code: result.code, discountPercent: result.discountPercent };
}

async function incrementPromoUsage(code) {
  await db.collection('promoCodes').doc(code.toUpperCase()).update({
    usedCount: admin.firestore.FieldValue.increment(1),
  });
}

module.exports = { validatePromoCode, applyPromoToUser, getUserPromo, incrementPromoUsage };
