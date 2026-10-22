'use strict';

// users/{uid}.trialUsed has two meanings today:
//   - `true`  — the 7-day subscription trial was granted (auth/telegram.js
//               registration, payment/[action].js trial);
//   - a number — how many free AI requests the Telegram bot has served
//               (ai/subscription.js increments it).
// A numeric value therefore says nothing about the subscription trial; the
// subscriptions/{uid} document is what decides that today.
//
// Target schema (prepared here, NOT written anywhere yet — switching the
// writers is a separate, owner-approved step; no migration is needed because
// the reader below understands both):
//   users/{uid}.subscriptionTrialStartedAt   when the 7-day trial was granted
//   users/{uid}.aiTrialRequestsUsed          free AI requests served by the bot
//   users/{uid}.trialUsed                    legacy, left as it is
//
// The reader reproduces today's decisions exactly (contract-tested against the
// real handlers): it changes nobody's rights.

/**
 * @param {object|null|undefined} user          users/{uid} data
 * @param {object|null|undefined} subscription  subscriptions/{uid} data (null when absent)
 * @returns {{ trialGrantAllowed: boolean, refusal: null|'TRIAL_USED'|'SUBSCRIPTION_EXISTS', aiTrialRequestsUsed: number }}
 */
function readTrialState(user, subscription) {
  let refusal = null;
  if (subscription) {
    refusal = subscription.paymentMethod === 'trial' ? 'TRIAL_USED' : 'SUBSCRIPTION_EXISTS';
  } else if (user && (user.trialUsed === true || user.subscriptionTrialStartedAt != null)) {
    refusal = 'TRIAL_USED';
  }

  let aiTrialRequestsUsed = 0;
  if (user && typeof user.aiTrialRequestsUsed === 'number' && Number.isFinite(user.aiTrialRequestsUsed) && user.aiTrialRequestsUsed > 0) {
    aiTrialRequestsUsed = Math.floor(user.aiTrialRequestsUsed);
  } else if (user && typeof user.trialUsed === 'number' && user.trialUsed > 0) {
    aiTrialRequestsUsed = Math.floor(user.trialUsed);
  }

  return { trialGrantAllowed: refusal === null, refusal, aiTrialRequestsUsed };
}

module.exports = { readTrialState };
