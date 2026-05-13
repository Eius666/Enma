/**
 * Client-side Telegram initData verification (TypeScript reference).
 *
 * In a browser context we cannot use Node's `crypto` module.  Use the
 * Web Crypto API instead (available in modern browsers and Vercel Edge Runtime).
 *
 * Usage in a typed Edge/API route:
 *   const result = await verifyTelegramInitData(initData);
 *   if (!result.ok) return new Response('Unauthorized', { status: 401 });
 *   const { user } = result;
 */

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  user?: TelegramUser;
  reason?: string;
}

/**
 * Verify Telegram Mini App initData HMAC-SHA256 signature using the Web Crypto
 * API (no Node.js dependency).
 *
 * @param initData  - raw Telegram.WebApp.initData string
 * @param botToken  - TELEGRAM_BOT_TOKEN (pass from env, never expose on client)
 */
export async function verifyTelegramInitData(
  initData: string,
  botToken: string
): Promise<VerifyResult> {
  if (!initData || !botToken) {
    return { ok: false, reason: 'Missing initData or botToken' };
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

    const encoder = new TextEncoder();

    // Step 1: HMAC-SHA256("WebAppData", botToken) → secretKey
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretKeyBytes = await crypto.subtle.sign(
      'HMAC',
      keyMaterial,
      encoder.encode(botToken)
    );

    // Step 2: HMAC-SHA256(secretKey, dataCheckString)
    const signingKey = await crypto.subtle.importKey(
      'raw',
      secretKeyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      signingKey,
      encoder.encode(dataCheckString)
    );

    const expectedHash = Array.from(new Uint8Array(signatureBytes))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (expectedHash !== hash) {
      return { ok: false, reason: 'initData signature mismatch' };
    }

    const userParam = params.get('user');
    const user: TelegramUser | undefined = userParam ? JSON.parse(userParam) : undefined;
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: `Verification error: ${(err as Error).message}` };
  }
}
