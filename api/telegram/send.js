'use strict';

const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const { verifyInitData } = require('../_lib/verifyWebhookSig');

const MAX_TEXT_LENGTH = 4096;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  // --- Rate limiting ---
  const ip = getClientIp(req);
  if (!rateLimit(`send:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
    res.status(429).json({ ok: false, description: 'Too many requests' });
    return;
  }

  // --- Caller authentication ---
  const initData = req.headers['x-telegram-init-data'] ?? '';
  const authResult = verifyInitData(initData);
  if (!authResult.ok) {
    res.status(401).json({ ok: false, description: 'Unauthorized' });
    return;
  }

  // --- Input validation ---
  const { chatId, text } = req.body || {};

  if (!chatId || !text) {
    res.status(400).json({ ok: false, description: 'Missing chatId or text' });
    return;
  }

  // chatId must be a positive integer (Telegram user IDs are always integers).
  const chatIdNum = Number(chatId);
  if (!Number.isInteger(chatIdNum) || chatIdNum <= 0) {
    res.status(400).json({ ok: false, description: 'Invalid chatId' });
    return;
  }

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
