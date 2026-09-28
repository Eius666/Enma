'use strict';

// ── Partner authentication ───────────────────────────────────────────────────
//
// Two unrelated crypto checks live here:
//
//   1. verifyTelegramLoginWidget — validates the payload Telegram's Login
//      Widget (https://core.telegram.org/widgets/login) posts to our page.
//      Secret key = SHA256(bot_token) (raw bytes), data-check-string = every
//      field except `hash`, sorted `key=value\n`. This is DIFFERENT from the
//      Mini App `initData` check in api/auth/telegram.js, which HMACs with
//      the literal string "WebAppData" as the key — two distinct,
//      Telegram-documented algorithms, not interchangeable.
//
//   2. Partner session tokens — a partner may not have an Enma account at
//      all (spec: "не обязательно быть пользователем Enma"), so we can't
//      reuse Firebase Auth. Instead: a small HMAC-signed opaque token
//      (payload.signature), same hand-rolled-crypto style already used for
//      admin TOTP in api/ai/[action].js — no new dependency.

const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_MAX_AGE_S = 24 * 60 * 60;            // Telegram widget payload freshness

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── 1. Telegram Login Widget ─────────────────────────────────────────────────

// payload: the JSON object the widget's callback receives (id, first_name,
// last_name?, username?, photo_url?, auth_date, hash).
function verifyTelegramLoginWidget(payload, botToken) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'empty_payload' };
  const { hash, ...fields } = payload;
  if (!hash || typeof hash !== 'string') return { ok: false, reason: 'missing_hash' };
  if (!botToken) return { ok: false, reason: 'server_misconfigured' };

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'missing_auth_date' };
  if (Math.abs(Date.now() / 1000 - authDate) > LOGIN_MAX_AGE_S) return { ok: false, reason: 'expired' };

  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  let valid = false;
  try {
    valid = expected.length === hash.length &&
      crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const id = Number(fields.id);
  if (!id) return { ok: false, reason: 'missing_id' };

  return {
    ok: true,
    user: {
      id,
      firstName: fields.first_name || '',
      lastName: fields.last_name || '',
      username: fields.username || '',
      photoUrl: fields.photo_url || '',
    },
  };
}

// ── 2. Partner session token ─────────────────────────────────────────────────

function sessionSecret() {
  const s = process.env.PARTNER_SESSION_SECRET;
  if (!s) throw new Error('PARTNER_SESSION_SECRET is not set');
  return s;
}

function issuePartnerSession(code) {
  const payload = { code, exp: Date.now() + SESSION_TTL_MS };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64url(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  return `${body}.${sig}`;
}

// Returns { ok, code } or { ok:false, reason }
function verifyPartnerSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }
  const [body, sig] = token.split('.');
  let expectedSig;
  try {
    expectedSig = base64url(crypto.createHmac('sha256', sessionSecret()).update(body).digest());
  } catch {
    return { ok: false, reason: 'server_misconfigured' };
  }
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_payload' };
  }
  if (!payload.code || !Number.isFinite(payload.exp)) return { ok: false, reason: 'bad_payload' };
  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, code: payload.code };
}

function bearerToken(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

module.exports = {
  verifyTelegramLoginWidget,
  issuePartnerSession,
  verifyPartnerSession,
  bearerToken,
};
