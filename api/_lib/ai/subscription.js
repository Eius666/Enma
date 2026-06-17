'use strict';

const { db } = require('../firebaseAdmin');

/**
 * Check whether a user has an active subscription.
 * Mirrors the client-side isSubscriptionActive() logic from src/subscription.ts.
 *
 * @param {string} userId
 * @returns {Promise<{ active: boolean, plan: string }>}
 */
async function checkSubscription(userId) {
  if (!userId) return { active: false, plan: 'none' };

  const snapshot = await db
    .collection('subscriptions')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return { active: false, plan: 'none' };

  const sub = snapshot.docs[0].data();
  const isActive = sub.endDate && new Date(sub.endDate) > new Date();
  return { active: Boolean(isActive), plan: isActive ? (sub.plan || 'pro') : 'none' };
}

module.exports = { checkSubscription };
