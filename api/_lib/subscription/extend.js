'use strict';

const { db, admin } = require('../firebaseAdmin');

// Shared subscription-extension rule, used by every payment rail (SBP,
// balance, Stars) so that paying for another period — through ANY method —
// never shortens time the user already paid for on a DIFFERENT method.
//
//   baseDate  = max(now, currentSubscription.endDate)
//   newEndDate = baseDate + purchasedPeriod
//
// Before this fix, each rail independently wrote `endDate = now + periodDays`,
// so e.g. a Stars purchase on day 5 of an active 30-day SBP subscription would
// RESET the expiry to day 35 instead of correctly extending it from day 30 to
// day 60 (see Telegram Stars Audit §10/§27).
//
// Returns the before/after end timestamps so callers can record enough on
// the payment doc to safely undo exactly this one extension later (see
// recalculateSubscriptionEntitlement in _lib/stars/payments.js) without a
// full ledger rebuild.
// Pure (no I/O) extension math, factored out so callers that need the
// payment-doc-idempotency-check and the subscription write in ONE atomic
// Firestore transaction (see _lib/stars/payments.js) can reuse the exact
// same rule without nesting transactions.
function computeExtension(current, periodDays) {
  const now = Date.now();
  const currentEndMs = Number.isFinite(current?.endDateMs)
    ? current.endDateMs
    : (current?.endDate ? new Date(current.endDate).getTime() : 0);
  const previousEndMs = Number.isFinite(currentEndMs) && currentEndMs > 0 ? currentEndMs : 0;

  const baseMs     = Math.max(now, previousEndMs);
  const newEndMs   = baseMs + periodDays * 24 * 60 * 60 * 1000;
  const newEndDate = new Date(newEndMs).toISOString();

  return { previousEndMs: previousEndMs || null, baseMs, newEndMs, newEndDate };
}

async function extendSubscription(userId, { plan, periodDays, paymentMethod, extra = {} }) {
  const subRef = db.collection('subscriptions').doc(userId);

  return db.runTransaction(async (tx) => {
    const snap    = await tx.get(subRef);
    const current = snap.exists ? snap.data() : null;
    const ext     = computeExtension(current, periodDays);

    tx.set(subRef, {
      userId,
      plan:              plan || current?.plan || 'pro',
      status:            'active',
      startDate:         current?.startDate || new Date().toISOString(),
      endDate:           ext.newEndDate,
      endDateMs:         ext.newEndMs,
      lastPaymentMethod: paymentMethod, // informational only — payment history lives in `payments`, see audit §11
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      ...extra,
    }, { merge: true });

    return ext;
  });
}

module.exports = { extendSubscription, computeExtension };
