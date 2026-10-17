'use strict';

require('../_lib/devEgressGuard'); // DEV only; no-op in production
const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const { verifyInitData } = require('../_lib/verifyWebhookSig');

const MAX_TEXT_LENGTH = 4096;
// Same freshness window as /api/auth/telegram.
const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  // --- Rate limiting ---
  const ip = getClientIp(req);
  if (!await rateLimit(`send:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ ok: false, description: 'Too many requests' });
    return;
  }

  // --- Caller authentication ---
  // The recipient is derived from the VERIFIED initData, never from the body.
  const initData = req.headers['x-telegram-init-data'] ?? '';
  const authResult = verifyInitData(initData, { maxAgeSeconds: INIT_DATA_MAX_AGE_S });
  if (!authResult.ok) {
    res.status(401).json({ ok: false, description: 'Unauthorized' });
    return;
  }
  const callerId = authResult.user && authResult.user.id;
  if (!Number.isSafeInteger(callerId) || callerId <= 0) {
    res.status(401).json({ ok: false, description: 'Unauthorized' });
    return;
  }

  // --- Input validation ---
  const { chatId, text } = req.body || {};

  if (!text) {
    res.status(400).json({ ok: false, description: 'Missing text' });
    return;
  }

  // A client may omit chatId (the server then uses its own verified id) or send
  // its own id as a number or a plain decimal string. Anything else — another
  // user's id, a group/channel id, '@name', '+123', '1e3', ' 123', '0123' — is
  // refused BEFORE any Telegram call.
  if (chatId !== undefined && chatId !== null && chatId !== '') {
    const canonical = typeof chatId === 'number' && Number.isSafeInteger(chatId) ? String(chatId)
      : typeof chatId === 'string' && /^[1-9][0-9]{0,15}$/.test(chatId) ? chatId
      : null;
    if (canonical !== String(callerId)) {
      res.status(403).json({ ok: false, description: 'Forbidden' });
      return;
    }
  }
  const chatIdNum = callerId;

  if (typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ ok: false, description: 'text must be a non-empty string' });
    return;
  }

  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ ok: false, description: `text exceeds ${MAX_TEXT_LENGTH} characters` });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, description: 'Missing TELEGRAM_BOT_TOKEN' });
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatIdNum, text: text.trim() })
    });
    const payload = await response.json();
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, description: 'Telegram request failed' });
  }
};
