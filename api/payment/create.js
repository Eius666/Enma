'use strict';

const { createSbpPayment, getSbpPaymentStatus }   = require('../_lib/platega');
const { validatePromoCode }                        = require('../_lib/promoCodes');
const { validateInfluencerCode }                   = require('../_lib/referral/influencer');
const { db, admin }                                = require('../_lib/firebaseAdmin');

// Mirror of src/subscription.ts SBP_PRICES
const SBP_PRICES = {
  pro:     { month: 750,  year: 7200  },
  premium: { month: 1000, year: 9600  },
};

function getBasePrice(plan, period) {
  return SBP_PRICES[plan]?.[period] ?? 1000;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { transactionId, uid } = req.query;

      // Promo validation (?validatePromo=CODE&userId=UID)
      const validateCode = req.query.validatePromo || req.query.promoCode;
      if (validateCode && !transactionId) {
        const result = await validatePromoCode(validateCode, req.query.userId || null);
        const finalAmount = result.valid
          ? Math.round(1000 * (1 - result.discountPercent / 100))
          : 1000;
        return res.status(200).json({ ok: true, ...result, finalAmount });
      }

      // Referral code validation (?validateReferral=CODE&userId=UID)
      const validateReferral = req.query.validateReferral;
      if (validateReferral && !transactionId) {
        const result = await validateInfluencerCode(validateReferral, req.query.userId || null);
        return res.status(200).json({ ok: true, ...result });
      }

      // Payment status (?transactionId=...&uid=...)
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

      // Discounts don't stack — take the maximum
      const discountPercent = Math.max(promoDiscount, referralDiscount);
      const finalAmount     = Math.round(BASE * (1 - discountPercent / 100));

      // User referral code: establish referredBy relationship (non-influencer codes)
      if (referralCode && validatedReferral === null) {
        try {
          const { findUserByReferralCode, handleReferralStart } = require('../_lib/referral/codes');
          const referrer = await findUserByReferralCode(referralCode);
          if (referrer && referrer.id !== userId) {
            await handleReferralStart(userId, referralCode);
          }
        } catch { /* non-fatal */ }
      }

      // useBalance: spend referralBalance toward this payment
      if (useBalance) {
        const userSnap = await db.collection('users').doc(userId).get();
        const balance  = userSnap.exists ? (userSnap.data().referralBalance || 0) : 0;

        if (balance > 0) {
          const balanceUsed = Math.min(balance, finalAmount);
          const toPay       = finalAmount - balanceUsed;

          if (toPay <= 0) {
            // Full balance covers the price — activate subscription directly
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

            return res.status(200).json({
              ok: true, activated: true,
              plan: planKey, endDate, balanceUsed,
            });
          }

          // Partial: create SBP payment for the remainder
          const result = await createSbpPayment({
            userId,
            finalAmount: toPay,
            userName:        userName || '',
            originalAmount:  BASE,
            discountPercent,
            promoCode:       validatedPromo,
            referralCode:    validatedReferral,
            plan:            planKey,
            period:          periodKey,
          });

          // Store balanceUsed in the payment doc (best-effort)
          try {
            const paySnap = await db.collection('payments')
              .where('transactionId', '==', result.transactionId)
              .limit(1)
              .get();
            if (!paySnap.empty) await paySnap.docs[0].ref.update({ balanceUsed });
          } catch { /* non-fatal */ }

          return res.status(200).json({
            ok: true, ...result,
            finalAmount: toPay, originalFinalAmount: finalAmount,
            discountPercent, promoDiscount, referralDiscount,
            balanceUsed,
          });
        }
      }

      // Normal SBP payment
      const result = await createSbpPayment({
        userId,
        finalAmount,
        userName:        userName || '',
        originalAmount:  BASE,
        discountPercent,
        promoCode:       validatedPromo,
        referralCode:    validatedReferral,
        plan:            planKey,
        period:          periodKey,
      });

      return res.status(200).json({
        ok: true, ...result,
        finalAmount, discountPercent,
        promoDiscount, referralDiscount,
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    if (err.userFacing) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
