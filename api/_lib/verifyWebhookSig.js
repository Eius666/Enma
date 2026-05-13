'use strict';

const crypto = require('crypto');

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header on incoming webhook
 * requests from Telegram.
 *
 * When you register a webhook you can supply a secret token:
 *   setWebhook(url=..., secret_token=TELEGRAM_WEBHOOK_SECRET)
 *
 * Telegram will then include that token verbatim in every subsequent webhook
 * POST as the `X-Telegram-Bot-Api-Secret-Token` header.  We compare it in
 * constant time to prevent timing-oracle attacks.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyWebhookSignature(req) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  // If no secret is configured we skip the check (allows local dev without
  // needing the env var).  Log a warning so this is visible in prod logs.
  if (!secret) {
    console.warn('[verifyWebhookSig] TELEGRAM_WEBHOOK_SECRET not set — skipping signature check');
    return { ok: true };
  }

  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!header) {
    return { ok: false, reason: 'Missing X-Telegram-Bot-Api-Secret-Token header' };
  }

  // Constant-time comparison to prevent timing attacks.
  const expected = Buffer.from(secret, 'utf8');
  const received = Buffer.from(String(header), 'utf8');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'Invalid webhook secret token' };
  }

  return { ok: true };
}

/**
 * Verify Telegram initData HMAC-SHA256 signature.
 *
 * Used when a Telegram Mini App client sends initData (as a string or header)
 * for the server to authenticate the user without a separate session.
 *
 * Algorithm (per Telegram docs):
 *  1. Parse initData query string into key=value pairs, exclude 'hash'
 *  2. Sort alphabetically and join with '\n'
 *  3. Compute HMAC-SHA256 of that string using key = HMAC-SHA256(botToken, "WebAppData")
 *  4. Compare result to the 'hash' field from initData
 *
 * @param {string} initData  — raw initData string from Telegram.WebApp.initData
 * @returns {{ ok: boolean, user?: object, reason?: string }}
 */
function verifyInitData(initData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return { ok: false, reason: 'TELEGRAM_BOT_TOKEN not configured' };
  }
  if (!initData || typeof initData !== 'string') {
    return { ok: false, reason: 'Missing initData' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { ok: false, reason: 'Missing hash in initData' };

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(hash, 'hex'))) {
      return { ok: false, reason: 'initData signature mismatch' };
    }

    const userParam = params.get('user');
    const user = userParam ? JSON.parse(userParam) : null;
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: `initData parse error: ${err.message}` };
  }
}

module.exports = { verifyWebhookSignature, verifyInitData };
