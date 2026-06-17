'use strict';

const { db } = require('../firebaseAdmin');

/**
 * Check whether a user has an active subscription.
 * Mirrors the client-side isSubscriptionActive() logic from src/subscription.ts.
 *
 * @param {string} userId
 * @returns {Promise<{ active: boolean, plan: string }>}
 */
// Comma-separated list of Telegram user IDs that bypass subscription checks.
const ADMIN_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

async function checkSubscription(userId) {
  if (!userId) return { active: false, plan: 'none' };

  if (ADMIN_IDS.has(String(userId))) {
    console.log('[subscription] admin access granted:', userId);
    return { active: true, plan: 'admin' };
  }

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
