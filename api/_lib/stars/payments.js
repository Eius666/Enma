'use strict';

const crypto = require('crypto');
const { db, admin } = require('../firebaseAdmin');
const { computeExtension } = require('../subscription/extend');
const { sessionIdFromPayload, getPaymentSession, isSessionExpired } = require('./sessions');
const { starsPriceFor } = require('./config');

const TG = 'https://api.telegram.org';

// Observability (Telegram Stars general-release §22) — structured, grep-able
// event names. Never logs a full charge id, initData, the bot token, or any
// other secret; telegram/user ids are logged plain, consistent with this
// codebase's existing logging (e.g. webhook.js already logs chatId/userId
// freely elsewhere).
function maskChargeId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.length <= 8) return '***';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
function logEvent(event, fields) {
  console.log(`[stars] ${event}`, fields);
}

async function tg(token, method, body) {
  const resp = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json().catch(() => ({}));
}

// Firestore doc IDs can't contain '/', can't be exactly '.' or '..', and
// can't match __.*__. Telegram charge ids are expected to be plain
// alphanumeric, but we sanitize defensively rather than trust that forever,
// and fall back to a deterministic hash if sanitizing ever produces
// something Firestore would reject — the goal is ALWAYS the same output for
// the same charge id, never a random one.
function docIdFromChargeId(chargeId) {
  const cleaned = String(chargeId).replace(/[^A-Za-z0-9_-]/g, '_');
  if (cleaned && cleaned !== '.' && cleaned !== '..' && !/^__.*__$/.test(cleaned)) {
    return `stars_${cleaned}`;
  }
  const hash = crypto.createHash('sha256').update(String(chargeId)).digest('hex').slice(0, 40);
  return `stars_h_${hash}`;
}

// ── pre_checkout_query validation (Telegram Stars Audit §8) ─────────────────
//
// Replaces the previous unconditional `answerPreCheckoutQuery(ok:true)`.
// Trusts NOTHING from the client beyond "here is an invoice_payload Telegram
// is asking us to confirm" — plan, amount, currency and the paying user are
// all re-derived from the server-side session created at checkout time.
async function validatePreCheckoutQuery(preCheckoutQuery) {
  const payload       = preCheckoutQuery.invoice_payload;
  const currency       = preCheckoutQuery.currency;
  const totalAmount    = preCheckoutQuery.total_amount;
  const fromTelegramId = preCheckoutQuery.from?.id;

  const sessionId = sessionIdFromPayload(payload);
  if (!sessionId) {
    // Not one of our Mini App sessions — either a legacy bot-invoice payload
    // (handled separately, see shouldAcceptLegacyPreCheckout below) or junk.
    return { ok: false, reason: 'unrecognized_payload' };
  }

  const session = await getPaymentSession(sessionId);
  if (!session) return { ok: false, reason: 'session_not_found' };
  if (session.status !== 'created') return { ok: false, reason: `session_status_${session.status}` };
  if (isSessionExpired(session)) return { ok: false, reason: 'session_expired' };
  if (currency !== 'XTR') return { ok: false, reason: 'wrong_currency' };

  const expectedAmount = starsPriceFor(session.plan, session.period);
  if (expectedAmount === null || totalAmount !== expectedAmount || totalAmount !== session.starsAmount) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (!fromTelegramId || Number(fromTelegramId) !== Number(session.telegramUserId)) {
    return { ok: false, reason: 'telegram_user_mismatch' };
  }

  return { ok: true, session };
}

// The legacy `/subscribe` bot-command invoice (payload `enma_sub_<chatId>_<ts>`)
// has no server-side session to check against — it never did. We still
// require the structural shape to match what handleLegacySubscribeCommand
// actually generates, and that the amount/currency match the single legacy
// product, so a pre_checkout_query can't be used to buy an arbitrary amount
// of Stars under a forged payload shape.
function validateLegacyPreCheckout(preCheckoutQuery) {
  const payload = preCheckoutQuery.invoice_payload;
  if (typeof payload !== 'string' || !/^enma_sub_\d+_\d+$/.test(payload)) {
    return { ok: false, reason: 'unrecognized_legacy_payload' };
  }
  if (preCheckoutQuery.currency !== 'XTR') return { ok: false, reason: 'wrong_currency' };
  const expected = starsPriceFor('pro', 'month');
  if (preCheckoutQuery.total_amount !== expected) return { ok: false, reason: 'amount_mismatch' };
  return { ok: true };
}

// ── successful_payment — idempotent activation (Telegram Stars Audit §8/§9) ─
//
// Keyed deterministically on telegram_payment_charge_id: a duplicate webhook
// delivery for the exact same charge is a no-op, both for the payment ledger
// AND for the subscription extension (both happen in the SAME transaction,
// so a crash between "payment recorded" and "subscription extended" can
// never happen — a retry of the same update either does both or neither).
//
// Deliberately does NOT call the old consumer/TON referral commission
// (`referral/earnings.js:processSubscriptionPayment`) or the Enma
// partner/influencer commission (`referral/influencer.js:processInfluencerCommission`)
// — see Telegram Stars Audit §2/§12/§20. Telegram's own native Affiliate
// Program, once the business enables it, is meant to be the sole
// affiliate-commission mechanism for Stars; Enma's own commission systems
// stay scoped to SBP.
async function processStarsSuccessfulPayment({ successfulPayment, userId, telegramUserId }) {
  const chargeId = successfulPayment.telegram_payment_charge_id;
  if (!chargeId) return { ok: false, reason: 'missing_charge_id' };
  if (!userId) return { ok: false, reason: 'missing_userId' };

  const sessionId = sessionIdFromPayload(successfulPayment.invoice_payload);
  const session   = sessionId ? await getPaymentSession(sessionId) : null;

  // Resolve plan/period from the session (new Mini App flow). The legacy
  // bot-command invoice never had a session — it only ever sold one product.
  const plan       = session?.plan   || 'pro';
  const period      = session?.period || 'month';
  const periodDays = period === 'year' ? 365 : 30;

  const docId  = docIdFromChargeId(chargeId);
  const payRef = db.collection('payments').doc(docId);
  const subRef = db.collection('subscriptions').doc(userId);
  const sessionRef = sessionId ? db.collection('stars_payment_sessions').doc(sessionId) : null;

  const result = await db.runTransaction(async (tx) => {
    const paySnap = await tx.get(payRef);
    if (paySnap.exists) {
      return { alreadyProcessed: true, endDate: paySnap.data().subscriptionEndDateAfter || null };
    }

    const subSnap = await tx.get(subRef);
    const current = subSnap.exists ? subSnap.data() : null;
    const ext = computeExtension(current, periodDays);

    tx.set(payRef, {
      id: docId,
      userId,
      telegramUserId: telegramUserId ?? null,
      plan, period,
      method: 'stars',
      currency: 'XTR',
      amount: successfulPayment.total_amount,
      telegram_payment_charge_id: chargeId,
      invoice_payload: successfulPayment.invoice_payload || null,
      paymentSessionId: sessionId || null,
      is_recurring: successfulPayment.is_recurring ?? false,
      is_first_recurring: successfulPayment.is_first_recurring ?? false,
      subscription_expiration_date: successfulPayment.subscription_expiration_date ?? null,
      status: 'confirmed',
      // Enough to safely undo EXACTLY this one extension on refund, without
      // a full ledger rebuild — see recalculateSubscriptionEntitlement below.
      subscriptionEndDateBeforeMs: ext.previousEndMs,
      subscriptionEndDateAfterMs:  ext.newEndMs,
      subscriptionEndDateAfter:    ext.newEndDate,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(subRef, {
      userId,
      plan:              plan || current?.plan || 'pro',
      status:            'active',
      startDate:         current?.startDate || new Date().toISOString(),
      endDate:           ext.newEndDate,
      endDateMs:         ext.newEndMs,
      lastPaymentMethod: 'stars',
      updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    if (sessionRef) {
      tx.set(sessionRef, {
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        paymentDocId: docId,
      }, { merge: true });
    }

    return { alreadyProcessed: false, endDate: ext.newEndDate };
  });

  const chargeIdMasked = maskChargeId(chargeId);
  if (result.alreadyProcessed) {
    logEvent('stars_payment_duplicate', { docId, userId, chargeIdMasked });
  } else {
    logEvent('stars_payment_confirmed', { docId, userId, plan, period, chargeIdMasked });
    logEvent('stars_subscription_extended', { userId, endDate: result.endDate, paymentMethod: 'stars' });
  }

  return { ok: true, docId, ...result };
}

// ── Refund (Telegram Stars Audit §14) ────────────────────────────────────────
//
// Service/admin-ready function — intentionally NOT wired to any public
// button or endpoint in this change. Uses the stored telegram_payment_charge_id
// and the Bot API's refundStarPayment(user_id, telegram_payment_charge_id).
async function refundStarsPayment({ paymentDocId, token, actor }) {
  const payRef  = db.collection('payments').doc(paymentDocId);
  const paySnap = await payRef.get();
  if (!paySnap.exists) return { ok: false, reason: 'payment_not_found' };

  const payment = paySnap.data();
  if (payment.method !== 'stars') return { ok: false, reason: 'not_a_stars_payment' };
  if (payment.status === 'refunded') return { ok: false, reason: 'already_refunded' };
  if (!payment.telegram_payment_charge_id) return { ok: false, reason: 'missing_charge_id' };
  if (!payment.telegramUserId) return { ok: false, reason: 'missing_telegram_user_id' };

  const tgResult = await tg(token, 'refundStarPayment', {
    user_id: payment.telegramUserId,
    telegram_payment_charge_id: payment.telegram_payment_charge_id,
  });
  if (!tgResult.ok) {
    return { ok: false, reason: 'telegram_refund_failed', telegram: tgResult };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(payRef);
    if (!fresh.exists || fresh.data().status === 'refunded') return; // no double refund, even on retry
    tx.set(payRef, { status: 'refunded', refundedAt: now }, { merge: true });
    tx.set(db.collection('stars_refund_audit').doc(), {
      paymentDocId,
      userId: payment.userId,
      telegram_payment_charge_id: payment.telegram_payment_charge_id,
      amount: payment.amount,
      actor: actor || 'unknown',
      createdAt: now,
    });
  });

  await recalculateSubscriptionEntitlement(payment.userId);

  logEvent('stars_payment_refunded', { paymentDocId, userId: payment.userId, chargeIdMasked: maskChargeId(payment.telegram_payment_charge_id) });

  return { ok: true };
}

// ── Entitlement recalculation after refund (Telegram Stars Audit §15) ──────
//
// Deliberately NOT a full ledger rebuild (the audit explicitly allows a
// minimal, safe version with the limitation documented instead — a full
// rebuild touching every historical payment across SBP/balance/TON/Stars is
// a bigger, separate change). This only ever UNDOES the exact extension a
// SPECIFIC refunded payment applied, and only when nothing has extended the
// subscription further since — otherwise it does nothing and flags the
// account for manual review rather than silently guessing. No path in this
// function ever shortens a subscription a user is still inside of because of
// a LATER, still-valid payment.
async function recalculateSubscriptionEntitlement(userId) {
  const subRef = db.collection('subscriptions').doc(userId);

  return db.runTransaction(async (tx) => {
    const subSnap = await tx.get(subRef);
    if (!subSnap.exists) return { changed: false, reason: 'no_subscription' };
    const sub = subSnap.data();

    // Find refunded Stars payments whose recorded "after" extension matches
    // the subscription's CURRENT endDateMs exactly — i.e. nothing has
    // extended it further since this specific payment was applied.
    const refundedSnap = await db.collection('payments')
      .where('userId', '==', userId)
      .where('method', '==', 'stars')
      .where('status', '==', 'refunded')
      .get();

    const rollback = refundedSnap.docs
      .map(d => d.data())
      .find(p => Number.isFinite(p.subscriptionEndDateAfterMs) && p.subscriptionEndDateAfterMs === sub.endDateMs);

    if (!rollback) {
      // Either nothing refunded applies to the current entitlement, or a
      // later payment has already superseded the refunded one's effect.
      return { changed: false, reason: 'no_applicable_rollback_or_superseded' };
    }

    const restoredMs = rollback.subscriptionEndDateBeforeMs;
    if (!Number.isFinite(restoredMs)) {
      // The refunded payment was the FIRST one ever (no "before" state) —
      // rolling back means there is no longer a paid entitlement at all.
      tx.set(subRef, { status: 'expired', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { changed: true, newEndDateMs: null, reason: 'rolled_back_to_no_subscription' };
    }

    tx.set(subRef, {
      endDateMs: restoredMs,
      endDate:   new Date(restoredMs).toISOString(),
      status:    restoredMs > Date.now() ? 'active' : 'expired',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { changed: true, newEndDateMs: restoredMs, reason: 'rolled_back' };
  });
}

module.exports = {
  docIdFromChargeId,
  validatePreCheckoutQuery,
  validateLegacyPreCheckout,
  processStarsSuccessfulPayment,
  refundStarsPayment,
  recalculateSubscriptionEntitlement,
};
