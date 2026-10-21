'use strict';

// Server-side subscription rules in one place (previously copied into
// createEntity.js, aiUsage.js, auth/telegram.js and payment/[action].js).
// The server is the trusted decision-maker; src/subscription.ts is the
// client's display copy — api/_lib/subscription/__tests__/planParity.test.mjs
// runs both over the same inputs and lists their known differences.

const TRIAL_DAYS = 7;

// Mirrors src/subscription.ts's AI_LIMITS (parity-tested). pdfReports: 0 for
// free AND pro — PDF export is premium-only by product design.
const AI_LIMITS = {
  free:    { textRequests: 0,   imageRequests: 0,  pdfReports: 0  },
  pro:     { textRequests: 20,  imageRequests: 0,  pdfReports: 0  },
  premium: { textRequests: 100, imageRequests: 30, pdfReports: 10 },
};

/**
 * The plan a subscriptions/{uid} document currently grants. Pure.
 *   - not 'active'                       -> free
 *   - free doc with a running trial      -> the trial plan
 *   - paid doc past its end (ms)         -> free
 *   - otherwise                          -> the stored plan
 */
function resolveActivePlan(sub, nowMs = Date.now()) {
  if (!sub) return 'free';
  if (sub.status !== 'active') return 'free';
  if (sub.plan === 'free' && sub.trialPlan && sub.trialEndDate) {
    if (new Date(sub.trialEndDate) > new Date(nowMs)) return sub.trialPlan;
  }
  const endMs = sub.endDateMs ?? sub.expiresAt?.toMillis?.() ?? 0;
  if (endMs && endMs < nowMs) return 'free';
  return sub.plan ?? 'free';
}

/** Trial window: TRIAL_DAYS from `now`, ending at the end of that local day. */
function computeTrialWindow(now = new Date()) {
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
  trialEnd.setHours(23, 59, 59, 999);
  return { now, trialEnd };
}

/** The subscriptions/{uid} document written when a trial is granted. */
function buildTrialSubscription(uid, { now, trialEnd }, updatedAt) {
  return {
    id:             `trial_${uid}`,
    userId:         uid,
    plan:           'free',
    trialPlan:      'premium',
    period:         'month',
    status:         'active',
    startDate:      now.toISOString(),
    endDate:        trialEnd.toISOString(),
    endDateMs:      trialEnd.getTime(),
    trialEndDate:   trialEnd.toISOString(),
    trialEndDateMs: trialEnd.getTime(),
    paymentMethod:  'trial',
    createdAt:      now.toISOString(),
    updatedAt,
  };
}

module.exports = { TRIAL_DAYS, AI_LIMITS, resolveActivePlan, computeTrialWindow, buildTrialSubscription };
