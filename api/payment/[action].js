'use strict';

// Routes:
//   GET/POST /api/payment/create   — initiate SBP payment
//   POST     /api/payment/callback — Platega webhook
//   POST     /api/payment/trial    — activate 7-day trial

const { createSbpPayment, getSbpPaymentStatus }   = require('../_lib/platega');
const { validatePromoCode }                        = require('../_lib/promoCodes');
const { validateInfluencerCode }                   = require('../_lib/referral/influencer');
const { db, admin }                                = require('../_lib/firebaseAdmin');

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

      if (referralCode) {
        const refResult = await validateInfluencerCode(referralCode, userId);
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
            const now        = new Date();
            const periodDays = periodKey === 'year' ? 365 : 30;
            const endDateObj = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);
            const endDate    = endDateObj.toISOString();
            const serverTs   = admin.firestore.FieldValue.serverTimestamp();

            await db.runTransaction(async tx => {
              const freshSnap    = await tx.get(db.collection('users').doc(userId));
              const freshBalance = freshSnap.exists ? (freshSnap.data().referralBalance || 0) : 0;
              if (freshBalance < balanceUsed) {
                const err = new Error('insufficient_balance');
                err.userFacing = true;
                throw err;
              }
              tx.set(db.collection('subscriptions').doc(userId), {
                userId, plan: planKey, period: periodKey, status: 'active',
                startDate:     now.toISOString(),
                endDate,
                endDateMs:     endDateObj.getTime(),
                paymentMethod: 'balance',
                amountRub:     balanceUsed,
                updatedAt:     serverTs,
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
      return res.status(200).json({ ok: true });
    }

    if (status === 'CONFIRMED') {
      if (payment.status === 'CONFIRMED') return res.status(200).json({ ok: true });

      const now        = admin.firestore.FieldValue.serverTimestamp();
      const plan       = payment.plan   || 'pro';
      const period     = payment.period || 'month';
      const periodDays = period === 'year' ? 365 : 30;
      const startDate  = new Date().toISOString();
      const endDateObj = new Date(Date.now() + periodDays * 24 * 60 * 60 * 1000);
      const endDate    = endDateObj.toISOString();
      const endDateMs  = endDateObj.getTime();
      const paidAmount = amount || payment.amount;

      console.log(`[callback] CONFIRMED userId=${payment.userId} plan=${plan} period=${period} endDate=${endDate}`);

      await payDoc.ref.update({ status: 'CONFIRMED', confirmedAt: now });
      await db.collection('subscriptions').doc(payment.userId).set({
        userId: payment.userId, plan, period, status: 'active',
        startDate, endDate, endDateMs,
        paymentId: transactionId, paymentMethod: 'sbp',
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
        await processInfluencerCommission(payment.userId, payment.referralCode, paidAmount, transactionId)
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

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const { action } = req.query;
  if (action === 'create')   return handleCreate(req, res);
  if (action === 'callback') return handleCallback(req, res);
  if (action === 'trial')    return handleTrial(req, res);
  return res.status(404).json({ ok: false, error: 'not_found' });
};
