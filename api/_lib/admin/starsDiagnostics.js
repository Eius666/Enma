'use strict';

// Admin: Telegram Stars canary diagnostics — POST /api/ai/adminStarsDiagnostics
// and adminStarsCanaryCheck. Read-only. Built by the api/ai router (see
// api/ai/[action].js).
//
// Never returns the bot token, a full charge id, initData or any secret —
// charge ids are masked, and nothing here does a write.

function maskChargeId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.length <= 8) return '***';
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function createStarsDiagnostics(ctx) {
  const { db, requireAdmin } = ctx;

  async function handleAdminStarsDiagnostics(req, res) {
    if (!requireAdmin(req, res)) return;

    const { STARS_MINIAPP_ENABLED } = require('../stars/config');
    const { canaryIds } = require('../stars/canary');

    const latestPaySnap = await db.collection('payments')
      .where('method', '==', 'stars')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const latestPayment = latestPaySnap.empty ? null : latestPaySnap.docs[0].data();
    const latestPaymentId = latestPaySnap.empty ? null : latestPaySnap.docs[0].id;

    let latestSession = null;
    if (latestPayment?.paymentSessionId) {
      const sSnap = await db.collection('stars_payment_sessions').doc(latestPayment.paymentSessionId).get();
      latestSession = sSnap.exists ? sSnap.data() : null;
    }

    let latestSubscription = null;
    if (latestPayment?.userId) {
      const subSnap = await db.collection('subscriptions').doc(latestPayment.userId).get();
      latestSubscription = subSnap.exists ? subSnap.data() : null;
    }

    return res.status(200).json({
      ok: true,
      starsMiniAppGlobalEnabled: STARS_MINIAPP_ENABLED,
      canaryConfigured: canaryIds().size > 0,
      canaryCount: canaryIds().size,
      latestPayment: latestPayment ? {
        docId:    latestPaymentId,
        status:   latestPayment.status,
        amount:   latestPayment.amount,
        currency: latestPayment.currency,
        plan:     latestPayment.plan,
        period:   latestPayment.period,
        isRecurring: latestPayment.is_recurring ?? false,
        createdAt: latestPayment.createdAt?.toDate?.()?.toISOString?.() || null,
      } : null,
      latestPaymentStatus: latestPayment?.status || null,
      latestPaymentChargeIdMasked: maskChargeId(latestPayment?.telegram_payment_charge_id),
      latestSession: latestSession ? {
        status: latestSession.status,
        plan: latestSession.plan,
        period: latestSession.period,
        starsAmount: latestSession.starsAmount,
        expiresAtMs: latestSession.expiresAtMs,
      } : null,
      latestSessionStatus: latestSession?.status || null,
      latestSubscription: latestSubscription ? {
        status: latestSubscription.status,
        plan: latestSubscription.plan,
        endDate: latestSubscription.endDate,
        endDateMs: latestSubscription.endDateMs,
        lastPaymentMethod: latestSubscription.lastPaymentMethod,
      } : null,
      // Reconciliation against Telegram's own ledger is a separate, explicit,
      // manual call (_lib/stars/reconcile.js:reconcileStarsTransactions) — this
      // read-only diagnostics endpoint never calls out to Telegram itself.
      telegramReconciliation: 'not run automatically — call reconcileStarsTransactions() manually',
    });
  }

  // Admin-only, self-service canary check (Telegram Stars canary rollout
  // diagnosis). Takes a real Telegram Mini App `initData` string in the body
  // — the SAME kind of value the Mini App itself sends to starsPlans/
  // starsCreate — and verifies it with the real production
  // TELEGRAM_BOT_TOKEN, so telegramUserId is never trusted from the request,
  // only derived from a passing HMAC check. Requires ADMIN_API_KEY on top of
  // that, so this can't be used to probe other users' canary status at scale
  // even though initData verification alone would already stop spoofing.
  //
  // Never returns the raw STARS_CANARY_TELEGRAM_IDS value or its list of ids.
  async function handleAdminStarsCanaryCheck(req, res) {
    if (!requireAdmin(req, res)) return;

    const { verifyInitData } = require('../verifyWebhookSig');
    const { STARS_MINIAPP_ENABLED, starsPriceFor } = require('../stars/config');
    const { canaryDiagnostics, isInCanary, isStarsEnabledForUser } = require('../stars/canary');

    const { initData } = req.body ?? {};
    if (!initData || typeof initData !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_initData' });
    }

    const auth = verifyInitData(initData);
    const telegramUserId = auth.ok ? auth.user?.id : null;
    const diag = canaryDiagnostics();
    const canaryMatched = telegramUserId ? isInCanary(telegramUserId) : false;
    const finalStarsEnabled = telegramUserId ? isStarsEnabledForUser(telegramUserId) : false;

    return res.status(200).json({
      ok: true,
      telegramUserResolved: auth.ok && !!telegramUserId,
      telegramUserId: auth.ok ? telegramUserId : null, // admin-only response — the admin already knows whose initData this is
      envPresent: diag.envPresent,
      entriesCountRaw: diag.entriesCountRaw,
      entriesCountValid: diag.entriesCountValid,
      allEntriesNumeric: diag.allEntriesNumeric,
      globalEnabled: STARS_MINIAPP_ENABLED,
      canaryMatched,
      isStarsEnabledForUserResult: finalStarsEnabled,
      // The exact same computation starsPlans itself would return for this user.
      starsPlansEquivalent: {
        starsEnabled: finalStarsEnabled,
        starsPrice: starsPriceFor('pro', 'month'),
      },
    });
  }

  return { handleAdminStarsDiagnostics, handleAdminStarsCanaryCheck };
}

module.exports = { createStarsDiagnostics, maskChargeId };
