'use strict';

const { db, admin } = require('./firebaseAdmin');

const SEED_CODES = {
  ENMATECH20: { discountPercent: 20, maxUses: 30 },
  ENMATECH50: { discountPercent: 50, maxUses: 30 },
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

// userId is optional; when provided, checks per-user usage
async function validatePromoCode(code, userId) {
  const codeUpper = code.trim().toUpperCase();
  await _ensureSeedCode(codeUpper);

  const snap = await db.collection('promoCodes').doc(codeUpper).get();
  if (!snap.exists) return { valid: false, error: 'not_found' };

  const promo = snap.data();
  if (!promo.active) return { valid: false, error: 'inactive' };
  if (promo.maxUses !== null && promo.maxUses !== undefined && promo.usedCount >= promo.maxUses) {
    return { valid: false, error: 'exhausted' };
  }

  if (userId) {
    const usedSnap = await db.collection('users').doc(userId)
      .collection('usedPromoCodes').doc(codeUpper).get();
    if (usedSnap.exists) return { valid: false, error: 'already_used' };
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

  const result = await validatePromoCode(code, null);
  if (!result.valid) return null;
  return { code: result.code, discountPercent: result.discountPercent };
}

// Write subcollection entry so the user cannot reuse the code
async function markPromoUsed(userId, code) {
  const codeUpper = code.toUpperCase();
  await db.collection('users').doc(userId)
    .collection('usedPromoCodes').doc(codeUpper).set({
      usedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

// Atomically check limit and increment inside a transaction
async function incrementPromoUsage(code) {
  const codeUpper = code.toUpperCase();
  const ref = db.collection('promoCodes').doc(codeUpper);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data     = snap.data();
    const current  = data.usedCount || 0;
    const maxUses  = data.maxUses;
    if (maxUses !== null && maxUses !== undefined && current >= maxUses) {
      throw new Error(`Promo ${codeUpper} limit exhausted`);
    }
    tx.update(ref, { usedCount: admin.firestore.FieldValue.increment(1) });
  });
}

module.exports = { validatePromoCode, applyPromoToUser, getUserPromo, markPromoUsed, incrementPromoUsage };
