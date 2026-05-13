'use strict';

const { rateLimit, getClientIp } = require('../_lib/rateLimit');

module.exports = async (req, res) => {
  const ip = getClientIp(req);
  const limitMax = req.method === 'POST' ? 20 : 60;
  if (!rateLimit(`test:${ip}`, limitMax, 60 * 1000)) {
    res.status(429).json({ ok: false, description: 'Too many requests' });
    return;
  }
  res.status(200).json({ ok: true, message: 'Webhook endpoint is alive!', method: req.method });
};
