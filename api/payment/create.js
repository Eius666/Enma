'use strict';

const { createSbpPayment, getSbpPaymentStatus } = require('../_lib/platega');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // GET ?transactionId=&uid= — poll payment status
    if (req.method === 'GET') {
      const { transactionId, uid } = req.query;
      if (!transactionId || !uid) {
        return res.status(400).json({ ok: false, error: 'Missing transactionId or uid' });
      }
      const result = await getSbpPaymentStatus(transactionId, uid);
      if (!result) return res.status(404).json({ ok: false, error: 'Payment not found' });
      return res.status(200).json({ ok: true, ...result });
    }

    // POST — create SBP payment
    if (req.method === 'POST') {
      const { userId, amount, userName } = req.body || {};
      if (!userId || !amount || Number(amount) <= 0) {
        return res.status(400).json({ ok: false, error: 'Invalid userId or amount' });
      }
      const result = await createSbpPayment(userId, Number(amount), userName || '');
      return res.status(200).json({ ok: true, ...result });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[payment/create]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
