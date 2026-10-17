'use strict';

// Firebase ID-token authentication for the payment API.
// Lives under api/_lib, so it is NOT a Vercel Function.
//
// Rollout mode: a missing Authorization header is logged and passed through;
// a request that DOES carry credentials must verify, and the body userId must
// match the verified uid. `required: true` turns a missing header into a 401.
//
// Project binding: verifyIdToken() is performed by the Firebase Admin SDK
// initialised in firebaseAdmin.js, which (a) verifies the RS256 signature
// against Google's keys and (b) rejects a token whose `aud`/`iss` is not the
// project of the service account in use. firebaseAdmin.js additionally pins
// the DEV service account to the DEV project (envIsolation), so a production
// token is rejected by DEV and vice versa.

const crypto = require('crypto');

const BEARER_RE = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/;

// Admin SDK error codes meaning "this token is not acceptable" (client's fault).
const INVALID_TOKEN_CODES = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/invalid-credential',
  'auth/user-disabled',
  'auth/user-not-found',
]);

function requestId(req) {
  const h = req && req.headers ? req.headers['x-vercel-id'] : null;
  if (typeof h === 'string' && /^[A-Za-z0-9:\-_.]{1,100}$/.test(h)) return h;
  return crypto.randomBytes(6).toString('hex');
}

// Structured, content-free log line. Never receives a token, header value,
// body, uid or any payment data — only the fields below.
function logPaymentAuth(event, { action, mode, code, id }) {
  console.log(JSON.stringify({ event, action, mode, code: code || null, requestId: id }));
}

function defaultVerifier() {
  const { admin } = require('../firebaseAdmin');
  return (token) => admin.auth().verifyIdToken(token);
}

/**
 * Authenticates a payment request.
 * @returns {Promise<{ok:true, uid:string|null, mode:'verified'|'missing'}
 *                  | {ok:false, status:number, error:string}>}
 *   On ok with mode 'verified', `uid` is the ONLY trusted identity.
 */
async function authenticatePaymentRequest(req, { action, bodyUserId, required = false } = {}, deps = {}) {
  const id = requestId(req);
  const header = req.headers ? req.headers.authorization : undefined;

  if (header === undefined || header === null || header === '') {
    if (required) {
      logPaymentAuth('payment_auth_invalid', { action, mode: 'required', code: 'missing', id });
      return { ok: false, status: 401, error: 'unauthorized' };
    }
    logPaymentAuth('payment_auth_missing', { action, mode: 'compat', id });
    return { ok: true, uid: null, mode: 'missing' };
  }

  const match = typeof header === 'string' ? BEARER_RE.exec(header) : null;
  if (!match) {
    logPaymentAuth('payment_auth_invalid', { action, mode: 'compat', code: 'bad_format', id });
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  let decoded;
  try {
    const verify = deps.verifyIdToken || defaultVerifier();
    decoded = await verify(match[1]);
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'unknown';
    if (INVALID_TOKEN_CODES.has(code)) {
      logPaymentAuth('payment_auth_invalid', { action, mode: 'compat', code, id });
      return { ok: false, status: 401, error: code === 'auth/id-token-expired' ? 'token_expired' : 'unauthorized' };
    }
    // Infrastructure / configuration failure: fail closed.
    logPaymentAuth('payment_auth_invalid', { action, mode: 'compat', code: 'verifier_unavailable', id });
    return { ok: false, status: 503, error: 'auth_unavailable' };
  }

  const uid = decoded && typeof decoded.uid === 'string' ? decoded.uid : '';
  if (!uid) {
    logPaymentAuth('payment_auth_invalid', { action, mode: 'compat', code: 'no_uid', id });
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  if (bodyUserId !== undefined && bodyUserId !== null && bodyUserId !== uid) {
    logPaymentAuth('payment_auth_uid_mismatch', { action, mode: 'compat', id });
    return { ok: false, status: 403, error: 'forbidden' };
  }

  logPaymentAuth('payment_auth_verified', { action, mode: 'compat', id });
  return { ok: true, uid, mode: 'verified' };
}

module.exports = { authenticatePaymentRequest, BEARER_RE, INVALID_TOKEN_CODES };
