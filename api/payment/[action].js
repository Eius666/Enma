'use strict';

// Routes:
//   GET/POST /api/payment/create   — initiate SBP payment
//   POST     /api/payment/callback — Platega webhook
//   POST     /api/payment/trial    — activate 7-day trial

const { createSbpPayment, getSbpPaymentStatus }   = require('../_lib/platega');
const { validatePromoCode }                        = require('../_lib/promoCodes');
const { validateInfluencerCode }                   = require('../_lib/referral/influencer');
const { db, admin }                                = require('../_lib/firebaseAdmin');
const { computeExtension }                         = require('../_lib/subscription/extend');
const { verifyInitData }                           = require('../_lib/verifyWebhookSig');
const { rateLimit, getClientIp }                   = require('../_lib/rateLimit');
const {
  starsPriceFor, isValidStarsPlan,
  STARS_MINIAPP_ENABLED, STARS_RECURRING_ENABLED, STARS_SUBSCRIPTION_PERIOD_SECONDS,
} = require('../_lib/stars/config');
const { createPaymentSession, getPaymentSession } = require('../_lib/stars/sessions');
const { isStarsEnabledForUser } = require('../_lib/stars/canary');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TRIAL_DAYS = 7;

const SBP_PRICES = {
  pro:     { month: 750,  year: 7200 },
  premium: { month: 1000, year: 9600 },
};

function getBasePrice(plan, period) {
  return SBP_PRICES[plan]?.[period] ?? 1000;
}

async function notifyUser(chatId, text) {
  if (!chatId || !BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(err => console.error('[callback] notify error:', err.message));
}

// ── /api/payment/create ───────────────────────────────────────────────────────

async function handleCreate(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { transactionId, uid } = req.query;

      const validateCode = req.query.validatePromo || req.query.promoCode;
      if (validateCode && !transactionId) {
        const result = await validatePromoCode(validateCode, req.query.userId || null);
        const finalAmount = result.valid
          ? Math.round(1000 * (1 - result.discountPercent / 100))
          : 1000;
        return res.status(200).json({ ok: true, ...result, finalAmount });
      }

      const validateReferral = req.query.validateReferral;
      if (validateReferral && !transactionId) {
        const result = await validateInfluencerCode(validateReferral, req.query.userId || null);
        return res.status(200).json({ ok: true, ...result });
      }

      if (!transactionId || !uid) {
        return res.status(400).json({ ok: false, error: 'Missing transactionId or uid' });
      }
      const result = await getSbpPaymentStatus(transactionId, uid);
      if (!result) return res.status(404).json({ ok: false, error: 'Payment not found' });
      return res.status(200).json({ ok: true, ...result });
    }

    if (req.method === 'POST') {
      const {
        userId, userName,
        promoCode, referralCode,
        plan = 'pro', period = 'month',
        useBalance,
      } = req.body || {};
      if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });

      const planKey   = ['pro', 'premium'].includes(plan)   ? plan   : 'pro';
      const periodKey = ['month', 'year'].includes(period)  ? period : 'month';
      const BASE      = getBasePrice(planKey, periodKey);

      let promoDiscount    = 0;
      let referralDiscount = 0;
      let validatedPromo   = null;
      let validatedReferral = null;

      if (promoCode) {
        const promoResult = await validatePromoCode(promoCode, userId);
        if (promoResult.valid) {
          promoDiscount  = promoResult.discountPercent;
          validatedPromo = promoResult.code;
        }
      }

      // Recurring payments: a payer attributed to a partner on an earlier
      // payment must keep crediting that same partner on every later one too
      // (renewal, upgrade, etc.) — otherwise "recurring commission" never
      // actually recurs, since the checkout UI only sends `referralCode` when
      // the payer manually types it. Explicit input still wins when present.
      let effectiveReferralCode = referralCode || null;
      if (!effectiveReferralCode) {
        const existingAttribution = await db.collection('users').doc(userId).get();
        if (existingAttribution.exists) {
          effectiveReferralCode = existingAttribution.data().referredByInfluencer || null;
        }
      }

      if (effectiveReferralCode) {
        const refResult = await validateInfluencerCode(effectiveReferralCode, userId);
        if (refResult.valid) {
          referralDiscount  = refResult.discountPercent;
          validatedReferral = refResult.code;
        }
      }

      const discountPercent = Math.max(promoDiscount, referralDiscount);
      const finalAmount     = Math.round(BASE * (1 - discountPercent / 100));

      if (referralCode && validatedReferral === null) {
        try {
          const { findUserByReferralCode, handleReferralStart } = require('../_lib/referral/codes');
          const referrer = await findUserByReferralCode(referralCode);
          if (referrer && referrer.id !== userId) {
            await handleReferralStart(userId, referralCode);
          }
        } catch { /* non-fatal */ }
      }

      if (useBalance) {
        const userSnap = await db.collection('users').doc(userId).get();
        const balance  = userSnap.exists ? (userSnap.data().referralBalance || 0) : 0;

        if (balance > 0) {
          const balanceUsed = Math.min(balance, finalAmount);
          const toPay       = finalAmount - balanceUsed;

          if (toPay <= 0) {
            const periodDays = periodKey === 'year' ? 365 : 30;
            const serverTs   = admin.firestore.FieldValue.serverTimestamp();
            const subRef     = db.collection('subscriptions').doc(userId);

            // endDate uses the same cross-rail rule as every other payment
            // method (Telegram Stars Audit §10): extends from the LATER of
            // "now" and the current paid-through date, so paying via balance
            // can never shorten time already paid for via SBP/Stars.
            const endDate = await db.runTransaction(async tx => {
              const freshSnap    = await tx.get(db.collection('users').doc(userId));
              const freshBalance = freshSnap.exists ? (freshSnap.data().referralBalance || 0) : 0;
              if (freshBalance < balanceUsed) {
                const err = new Error('insufficient_balance');
                err.userFacing = true;
                throw err;
              }

              const subSnap = await tx.get(subRef);
              const current = subSnap.exists ? subSnap.data() : null;
              const ext     = computeExtension(current, periodDays);

              tx.set(subRef, {
                userId, plan: planKey, period: periodKey, status: 'active',
                startDate:         current?.startDate || new Date().toISOString(),
                endDate:           ext.newEndDate,
                endDateMs:         ext.newEndMs,
                lastPaymentMethod: 'balance',
                amountRub:         balanceUsed,
                updatedAt:         serverTs,
              }, { merge: true });
              tx.set(db.collection('users').doc(userId), {
                referralBalance: admin.firestore.FieldValue.increment(-balanceUsed),
                isPro:           true,
                updatedAt:       serverTs,
              }, { merge: true });
              tx.set(db.collection('payments').doc(), {
                userId, plan: planKey, period: periodKey,
                amount: balanceUsed, finalAmount: balanceUsed, originalAmount: BASE,
                method: 'balance', status: 'CONFIRMED', balanceUsed,
                promoCode:    validatedPromo    || null,
                referralCode: validatedReferral || null,
                createdAt:    serverTs,
              });
              return ext.newEndDate;
            });

            return res.status(200).json({ ok: true, activated: true, plan: planKey, endDate, balanceUsed });
          }

          const result = await createSbpPayment({
            userId, finalAmount: toPay, userName: userName || '',
            originalAmount: BASE, discountPercent,
            promoCode: validatedPromo, referralCode: validatedReferral,
            plan: planKey, period: periodKey,
          });

          try {
            const paySnap = await db.collection('payments')
              .where('transactionId', '==', result.transactionId)
              .limit(1).get();
            if (!paySnap.empty) await paySnap.docs[0].ref.update({ balanceUsed });
          } catch { /* non-fatal */ }

          return res.status(200).json({
            ok: true, ...result,
            finalAmount: toPay, originalFinalAmount: finalAmount,
            discountPercent, promoDiscount, referralDiscount, balanceUsed,
          });
        }
      }

      const result = await createSbpPayment({
        userId, finalAmount, userName: userName || '',
        originalAmount: BASE, discountPercent,
        promoCode: validatedPromo, referralCode: validatedReferral,
        plan: planKey, period: periodKey,
      });

      return res.status(200).json({ ok: true, ...result, finalAmount, discountPercent, promoDiscount, referralDiscount });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    if (err.userFacing) return res.status(400).json({ ok: false, error: err.message });
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ── /api/payment/callback ─────────────────────────────────────────────────────

async function handleCallback(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  try {
    const merchantId = process.env.PLATEGA_MERCHANT_ID;
    const secret     = process.env.PLATEGA_SECRET;

    const incomingMerchant = req.headers['x-merchantid'] || req.headers['x-merchantId'];
    const incomingSecret   = req.headers['x-secret'];

    // Fail closed: an unset env var must never make "no header" equal "no secret".
    if (!merchantId || !secret || incomingMerchant !== merchantId || incomingSecret !== secret) {
      console.warn('[payment/callback] invalid credentials in headers');
      return res.status(200).json({ ok: true });
    }

    const { id: transactionId, amount, status } = req.body || {};
    if (!transactionId || !status) return res.status(200).json({ ok: true });

    const snap = await db.collection('payments')
      .where('transactionId', '==', transactionId)
      .limit(1).get();

    if (snap.empty) {
      console.warn('[payment/callback] unknown transactionId:', transactionId);
      return res.status(200).json({ ok: true });
    }

    const payDoc  = snap.docs[0];
    const payment = payDoc.data();

    if (status === 'CANCELED') {
      await payDoc.ref.update({ status: 'CANCELED' });
      // Claws back a partner's commission if this payment was confirmed and
      // then cancelled within the window; a no-op if it was never confirmed
      // (nothing to claw back) or the window already passed.
      if (payment.referralCode) {
        const { cancelInfluencerCommission } = require('../_lib/referral/influencer');
        await cancelInfluencerCommission(payment.userId, transactionId)
          .catch(e => console.error('[callback] commission clawback error:', e.message));
      }
      return res.status(200).json({ ok: true });
    }

    if (status === 'CONFIRMED') {
      if (payment.status === 'CONFIRMED') return res.status(200).json({ ok: true });

      const now        = admin.firestore.FieldValue.serverTimestamp();
      const plan       = payment.plan   || 'pro';
      const period     = payment.period || 'month';
      const periodDays = period === 'year' ? 365 : 30;
      const paidAmount = amount || payment.amount;

      // endDate uses the same cross-rail rule as balance/Stars payments
      // (Telegram Stars Audit §10): extends from the LATER of "now" and the
      // current paid-through date, so SBP can never shorten time already
      // paid for via another method.
      const subRef   = db.collection('subscriptions').doc(payment.userId);
      const subSnap  = await subRef.get();
      const current  = subSnap.exists ? subSnap.data() : null;
      const ext      = computeExtension(current, periodDays);
      const startDate = current?.startDate || new Date().toISOString();
      const endDate   = ext.newEndDate;

      console.log(`[callback] CONFIRMED userId=${payment.userId} plan=${plan} period=${period} endDate=${endDate}`);

      await payDoc.ref.update({ status: 'CONFIRMED', confirmedAt: now });
      await subRef.set({
        userId: payment.userId, plan, period, status: 'active',
        startDate, endDate, endDateMs: ext.newEndMs,
        paymentId: transactionId, lastPaymentMethod: 'sbp',
        amountRub: paidAmount, updatedAt: now,
      }, { merge: true });

      await db.collection('users').doc(payment.userId).set({
        balance:      admin.firestore.FieldValue.increment(paidAmount),
        isPro:        true,
        subscription: { plan, period, status: 'active', startDate, endDate, paymentMethod: 'sbp', userId: payment.userId, updatedAt: startDate },
        updatedAt:    now,
      }, { merge: true });

      if (payment.promoCode) {
        const { incrementPromoUsage, markPromoUsed } = require('../_lib/promoCodes');
        await Promise.all([
          incrementPromoUsage(payment.promoCode).catch(e => console.error('[callback] promo increment:', e.message)),
          markPromoUsed(payment.userId, payment.promoCode).catch(e => console.error('[callback] promo mark:', e.message)),
        ]);
      }

      if (payment.referralCode) {
        const { processInfluencerCommission } = require('../_lib/referral/influencer');
        await processInfluencerCommission(payment.userId, payment.referralCode, paidAmount, transactionId, BOT_TOKEN)
          .catch(e => console.error('[callback] referral commission:', e.message));
      }

      try {
        const { creditReferralBalance } = require('../_lib/referral/earnings');
        await creditReferralBalance(payment.userId, paidAmount);
      } catch (e) {
        console.error('[callback] cashback error:', e.message);
      }

      if (payment.balanceUsed > 0) {
        await db.runTransaction(async tx => {
          const userRef = db.collection('users').doc(payment.userId);
          const s       = await tx.get(userRef);
          const current = s.exists ? (s.data().referralBalance || 0) : 0;
          const deduct  = Math.min(current, payment.balanceUsed);
          if (deduct > 0) {
            tx.set(userRef, { referralBalance: admin.firestore.FieldValue.increment(-deduct) }, { merge: true });
          }
        }).catch(e => console.error('[callback] balance deduct error:', e.message));
      }

      const userSnap    = await db.collection('users').doc(payment.userId).get();
      const chatId      = userSnap.exists ? userSnap.data().chatId : null;
      const amountText  = payment.discountPercent
        ? `${paidAmount} ₽ (скидка ${payment.discountPercent}%)`
        : `${paidAmount} ₽`;
      const durationLabel = period === 'year' ? '1 год' : '30 дней';
      await notifyUser(chatId,
        `✅ Платёж на <b>${amountText}</b> подтверждён!\n\n` +
        `Enma ${plan === 'premium' ? 'Premium' : 'Pro'} активна на ${durationLabel} 🎉`
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[payment/callback] error:', err.message);
    return res.status(200).json({ ok: true });
  }
}

// ── /api/payment/trial ────────────────────────────────────────────────────────

async function handleTrial(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.body ?? {};
  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    const userRef  = db.collection('users').doc(userId);
    const userSnap = await userRef.get();

    if (userSnap.exists && userSnap.data()?.trialUsed === true) {
      return res.status(409).json({ error: 'Trial already used', code: 'TRIAL_USED' });
    }

    const now      = new Date();
    const trialEnd = new Date(now);
    trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
    trialEnd.setHours(23, 59, 59, 999);

    const subRef = db.collection('subscriptions').doc(userId);

    await db.runTransaction(async tx => {
      tx.set(subRef, {
        id:             `trial_${userId}`,
        userId,
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
        updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(userRef, { trialUsed: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });

    return res.status(200).json({ ok: true, trialEndDate: trialEnd.toISOString() });
  } catch (err) {
    console.error('[payment/trial] error', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ── /api/payment/starsPlans — canonical Stars price (Telegram Stars Audit §6) ──
//
// Frontend must NOT compute the Stars price itself (the old USD/STAR_USD_RATE
// calculator in src/subscription.ts is dead and deprecated) — it fetches the
// real, plan-specific number from here. Pro and Premium have different real
// USD prices (PLAN_USD_PRICES) and therefore different Stars prices — they
// must never collapse to one shared flat value again.
//
// starsEnabled reflects THIS caller specifically (canary allowlist) — not
// just the global flag — so the Mini App only shows the Stars method to
// users the backend actually agrees to let use it. initData is optional
// here (an unauthenticated/non-Telegram caller just sees the global state,
// never an error) but when present it is verified, never trusted raw.

async function handleStarsPlans(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Per-caller result (canary/global flag, future price changes) — must
  // never be cached by a shared/CDN cache, and a client shouldn't reuse an
  // old response across page loads either.
  res.setHeader('Cache-Control', 'private, no-store');

  const initData = req.headers['x-telegram-init-data'] ?? '';
  const auth = initData ? verifyInitData(initData) : { ok: false };
  const telegramUserId = auth.ok ? auth.user?.id : null;

  return res.status(200).json({
    ok: true,
    starsEnabled: isStarsEnabledForUser(telegramUserId),
    pro:     { month: { starsPrice: starsPriceFor('pro', 'month') } },
    premium: { month: { starsPrice: starsPriceFor('premium', 'month') } },
  });
}

// ── /api/payment/starsCreate — Mini App Stars checkout (Telegram Stars Audit §5/§7) ──
//
// Caller authentication is Telegram Mini App initData ONLY — never a
// client-supplied userId. plan/period are validated against the single
// server-side source of truth; nothing about the price, plan or paying user
// is ever accepted from the request body as fact. The canary allowlist is
// enforced HERE, server-side, regardless of what the frontend chose to show
// — calling this endpoint directly can never bypass it.

async function handleStarsCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const ip = getClientIp(req);
  if (!await rateLimit(`starsCreate:${ip}`, 10, 60_000)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const initData = req.headers['x-telegram-init-data'] ?? '';
  const auth     = verifyInitData(initData);
  if (!auth.ok || !auth.user?.id) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const telegramUserId = auth.user.id;

  if (!isStarsEnabledForUser(telegramUserId)) {
    return res.status(403).json({ ok: false, error: 'STARS_NOT_ENABLED' });
  }

  const userSnap = await db.collection('users').where('chatId', '==', telegramUserId).limit(1).get();
  if (userSnap.empty) {
    return res.status(404).json({ ok: false, error: 'user_not_found' });
  }
  const userId = userSnap.docs[0].id;

  const { plan = 'pro', period = 'month' } = req.body || {};
  if (!isValidStarsPlan(plan, period)) {
    return res.status(400).json({ ok: false, error: 'invalid_plan' });
  }

  let session;
  try {
    session = await createPaymentSession({ userId, telegramUserId, plan, period });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.code || 'session_create_failed' });
  }

  // Title/description/label must match the ACTUAL plan being sold — a
  // Premium purchase must never show "Enma Pro" in the Telegram invoice
  // sheet (Telegram Stars Audit §10).
  const planLabel = plan === 'premium' ? 'Premium' : 'Pro';
  const planDescription = plan === 'premium'
    ? 'Безлимит + AI-изображения, PDF-отчёты, AI-чат, семейный доступ'
    : 'Безлимит сообщений, AI-ассистент, финансы, напоминания';

  const invoiceBody = {
    title:       `Enma ${planLabel} — 1 месяц`,
    description: planDescription,
    payload:     session.payload,
    provider_token: '', // required empty string for Telegram Stars (XTR)
    currency:    'XTR',
    prices:      [{ label: `Enma ${planLabel} · 1 месяц`, amount: session.starsAmount }],
  };
  if (STARS_RECURRING_ENABLED) {
    invoiceBody.subscription_period = STARS_SUBSCRIPTION_PERIOD_SECONDS;
  }

  try {
    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(invoiceBody),
    });
    const tgData = await tgResp.json();
    if (!tgData.ok) {
      console.error('[payment/starsCreate] Telegram error:', tgData.description);
      return res.status(502).json({ ok: false, error: 'telegram_error' });
    }
    console.log('[stars] stars_invoice_created', { userId, telegramUserId, plan, period, sessionId: session.sessionId });
    return res.status(200).json({
      ok: true,
      invoiceUrl: tgData.result,
      sessionId:  session.sessionId,
      starsAmount: session.starsAmount,
      expiresAtMs: session.expiresAtMs,
    });
  } catch (err) {
    console.error('[payment/starsCreate] error:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

// ── /api/payment/starsSession — poll session status from the Mini App ──────
//
// Same canary + initData rules as starsCreate, PLUS the caller must be the
// session's own owner — one user polling another's session id is refused
// even if both happen to be canary-allowed.

async function handleStarsSession(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Polled payment status — must always hit the network, never a cache.
  res.setHeader('Cache-Control', 'private, no-store');

  const initData = req.headers['x-telegram-init-data'] ?? '';
  const auth     = verifyInitData(initData);
  if (!auth.ok || !auth.user?.id) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const telegramUserId = auth.user.id;

  if (!isStarsEnabledForUser(telegramUserId)) {
    return res.status(403).json({ ok: false, error: 'STARS_NOT_ENABLED' });
  }

  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'missing_sessionId' });

  const session = await getPaymentSession(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'not_found' });
  if (Number(session.telegramUserId) !== Number(telegramUserId)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  return res.status(200).json({ ok: true, status: session.status });
}

// ── /api/payment/version — stale-bundle detection (cache-bust) ─────────────────
//
// Lives here, as one more action on this already-shared function, rather than
// as its own top-level api/version.js file — Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions, and this project is already at that
// limit; adding a dedicated function for this broke every deploy with
// "No more than 12 Serverless Functions can be added to a Deployment on the
// Hobby plan." api/_generated/buildId.json is written fresh by
// scripts/generateBuildId.js on every build (gitignored, never committed).

let cachedBuildInfo;
function getBuildInfo() {
  if (cachedBuildInfo) return cachedBuildInfo;
  try {
    cachedBuildInfo = require('../_generated/buildId.json');
  } catch {
    cachedBuildInfo = { buildId: 'unknown' };
  }
  return cachedBuildInfo;
}

async function handleVersion(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  // This endpoint's entire purpose is to never be served stale — a cached
  // "old" response here would defeat the whole mechanism.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, buildId: getBuildInfo().buildId });
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const { action } = req.query;
  if (action === 'create')      return handleCreate(req, res);
  if (action === 'callback')    return handleCallback(req, res);
  if (action === 'trial')       return handleTrial(req, res);
  if (action === 'starsPlans')  return handleStarsPlans(req, res);
  if (action === 'starsCreate') return handleStarsCreate(req, res);
  if (action === 'starsSession')return handleStarsSession(req, res);
  if (action === 'version')     return handleVersion(req, res);
  return res.status(404).json({ ok: false, error: 'not_found' });
};
