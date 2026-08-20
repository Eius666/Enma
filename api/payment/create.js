'use strict';

const { createSbpPayment, getSbpPaymentStatus }   = require('../_lib/platega');
const { validatePromoCode }                        = require('../_lib/promoCodes');
const { validateInfluencerCode }                   = require('../_lib/referral/influencer');

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
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
