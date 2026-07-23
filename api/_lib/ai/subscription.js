'use strict';

const { admin, db } = require('../firebaseAdmin');

const TRIAL_LIMIT = 5;

/**
 * Check whether a user has an active subscription.
 * Mirrors the client-side isSubscriptionActive() logic from src/subscription.ts.
 *
 * @param {string} userId
 * @returns {Promise<{ active: boolean, plan: string }>}
 */
// Comma-separated list of Telegram user IDs that bypass subscription checks.
// IDs are stored as strings so number/string comparisons always work.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map(id => String(id).trim())
    .filter(Boolean)
);

async function checkSubscription(userId) {
  if (!userId) return { active: false, plan: 'none' };

  const userIdStr = String(userId);
  if (ADMIN_IDS.has(userIdStr)) return { active: true, plan: 'admin' };

  // Two equality filters — no composite index needed (orderBy removed to avoid
  // requiring a (userId, status, updatedAt) index that is not in firestore.indexes.json).
  const snapshot = await db
    .collection('subscriptions')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snapshot.empty) return { active: false, plan: 'none' };

  const sub = snapshot.docs[0].data();
  const isActive = sub.endDate && new Date(sub.endDate) > new Date();
  return { active: Boolean(isActive), plan: isActive ? (sub.plan || 'pro') : 'none' };
}

async function getTrialUsed(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return 0;
  const val = userDoc.data().trialUsed;
  return typeof val === 'number' && val > 0 ? Math.floor(val) : 0;
}

async function incrementTrialUsed(userId) {
  await db.collection('users').doc(userId).set(
    { trialUsed: admin.firestore.FieldValue.increment(1) },
    { merge: true }
  );
}

module.exports = { checkSubscription, getTrialUsed, incrementTrialUsed, TRIAL_LIMIT };
