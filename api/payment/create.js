'use strict';

const { createSbpPayment, getSbpPaymentStatus } = require('../_lib/platega');
const { validatePromoCode }                      = require('../_lib/promoCodes');

// Mirror of src/subscription.ts SBP_PRICES
const SBP_PRICES = {
  pro:      { month: 1000,  year: 12000 },
  business: { month: 1500,  year: 15000 },
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

      // Promo validation (?validatePromo=CODE)
      const validateCode = req.query.validatePromo || req.query.promoCode;
      if (validateCode && !transactionId) {
        const result = await validatePromoCode(validateCode);
        const finalAmount = result.valid
          ? Math.round(1000 * (1 - result.discountPercent / 100))
          : 1000;
        return res.status(200).json({ ok: true, ...result, finalAmount });
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
      const { userId, userName, promoCode, plan = 'pro', period = 'month' } = req.body || {};
      if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });

      const planKey   = ['pro', 'business'].includes(plan)    ? plan   : 'pro';
      const periodKey = ['month', 'year'].includes(period)    ? period : 'month';
      const BASE      = getBasePrice(planKey, periodKey);

      let finalAmount      = BASE;
      let discountPercent  = 0;
      let validatedPromo   = null;

      if (promoCode) {
        const promoResult = await validatePromoCode(promoCode);
        if (promoResult.valid) {
          discountPercent = promoResult.discountPercent;
          finalAmount     = Math.round(BASE * (1 - discountPercent / 100));
          validatedPromo  = promoResult.code;
        }
      }

      const result = await createSbpPayment({
        userId,
        finalAmount,
        userName:        userName || '',
        originalAmount:  BASE,
        discountPercent,
        promoCode:       validatedPromo,
        plan:            planKey,
        period:          periodKey,
      });

      return res.status(200).json({ ok: true, ...result, finalAmount, discountPercent });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
