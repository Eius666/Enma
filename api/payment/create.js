'use strict';

const { createSbpPayment, getSbpPaymentStatus, BASE_PRICE } = require('../_lib/platega');
const { validatePromoCode } = require('../_lib/promoCodes');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { transactionId, uid, promoCode } = req.query;

      // Promo validation sub-route
      if (promoCode) {
        const result = await validatePromoCode(promoCode);
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
      const { userId, userName, promoCode } = req.body || {};
      if (!userId) return res.status(400).json({ ok: false, error: 'Missing userId' });

      let finalAmount      = BASE_PRICE;
      let discountPercent  = 0;
      let validatedPromo   = null;

      if (promoCode) {
        const promoResult = await validatePromoCode(promoCode);
        if (promoResult.valid) {
          discountPercent = promoResult.discountPercent;
          finalAmount     = Math.round(BASE_PRICE * (1 - discountPercent / 100));
          validatedPromo  = promoResult.code;
        }
      }

      const result = await createSbpPayment({
        userId,
        finalAmount,
        userName:        userName || '',
        originalAmount:  BASE_PRICE,
        discountPercent,
        promoCode:       validatedPromo,
      });

      return res.status(200).json({ ok: true, ...result, finalAmount, discountPercent });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
