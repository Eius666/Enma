'use strict';

// One-shot endpoint to register the Telegram webhook URL.
// Protected with CRON_SECRET.
// GET /api/setup-webhook?secret=<CRON_SECRET>
// GET /api/setup-webhook?secret=<CRON_SECRET>&dry=1   ← just shows current info

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerOk = req.headers.authorization === `Bearer ${secret}`;
    const queryOk  = req.query?.secret === secret;
    if (!headerOk && !queryOk) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' });
    return;
  }

  const targetUrl = `https://enma-silk.vercel.app/api/telegram/webhook`;

  // Get current webhook info
  const infoResp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const info     = await infoResp.json();
  const current  = info.result?.url;

  if (req.query?.dry === '1') {
    res.status(200).json({
      current_webhook: current,
      target_webhook:  targetUrl,
      action: 'dry run — add &dry=0 to actually set it',
    });
    return;
  }

  // Set the webhook
  const setResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url:             targetUrl,
      allowed_updates: ['message'],   // only text messages, drops noise
      drop_pending_updates: true,     // clear the queue so old messages don't flood
    }),
  });
  const result = await setResp.json();

  res.status(200).json({
    previous_webhook: current,
    new_webhook:      targetUrl,
    telegram_response: result,
  });
};
