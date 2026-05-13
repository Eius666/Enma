/**
 * Typed interface for webhook signature verification.
 * The actual runtime implementation lives in api/_lib/verifyWebhookSig.js
 * (CommonJS Node.js).  This file provides TypeScript types for use in typed
 * route handlers or Edge functions.
 */

export interface WebhookVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header.
 *
 * When you register a webhook with Telegram you can supply a secret token:
 *   setWebhook(url=..., secret_token="your-secret")
 *
 * Telegram will include it in every webhook POST as:
 *   X-Telegram-Bot-Api-Secret-Token: your-secret
 *
 * We compare in constant time to prevent timing oracle attacks.
 *
 * @param headerValue  - value of X-Telegram-Bot-Api-Secret-Token from the request
 * @param expectedSecret - TELEGRAM_WEBHOOK_SECRET from env
 */
export function verifyWebhookSignature(
  headerValue: string | undefined,
  expectedSecret: string
): WebhookVerifyResult {
  if (!headerValue) {
    return { ok: false, reason: 'Missing X-Telegram-Bot-Api-Secret-Token header' };
  }

  // Constant-time comparison using XOR to prevent timing attacks.
  const expected = expectedSecret;
  const received = headerValue;

  if (expected.length !== received.length) {
    return { ok: false, reason: 'Invalid webhook secret token' };
  }

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  }

  if (mismatch !== 0) {
    return { ok: false, reason: 'Invalid webhook secret token' };
  }

  return { ok: true };
}
