'use strict';

// Server-side payment sessions for the Mini App Stars flow (Telegram Stars
// Audit §7). The invoice payload Telegram sends back in pre_checkout_query /
// successful_payment carries ONLY this opaque session id — never a raw
// amount, plan or uid — so a tampered client can't request a cheap session
// and claim a different price/plan/user at checkout time.

const crypto = require('crypto');
const { db, admin } = require('../firebaseAdmin');
const { starsPriceFor, isValidStarsPlan, PAYMENT_SESSION_TTL_MS } = require('./config');

const PAYLOAD_PREFIX = 'enma_stars:';

function newSessionId() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars, unguessable
}

function payloadFor(sessionId) {
  return `${PAYLOAD_PREFIX}${sessionId}`;
}

// Returns the sessionId encoded in an invoice payload, or null if the
// payload isn't one of ours (e.g. a legacy `/subscribe` invoice payload, or
// garbage — never trust it blindly).
function sessionIdFromPayload(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(PAYLOAD_PREFIX)) return null;
  const id = payload.slice(PAYLOAD_PREFIX.length);
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
}

// userId/telegramUserId come from the caller's ALREADY-VERIFIED initData —
// this function trusts them completely and does no auth itself.
async function createPaymentSession({ userId, telegramUserId, plan, period }) {
  if (!userId || !telegramUserId) throw new Error('userId and telegramUserId are required');
  if (!isValidStarsPlan(plan, period)) {
    const err = new Error(`No Stars price configured for plan=${plan} period=${period}`);
    err.code = 'invalid_plan';
    throw err;
  }

  const starsAmount = starsPriceFor(plan, period);
  const sessionId    = newSessionId();
  const now          = Date.now();
  const expiresAtMs  = now + PAYMENT_SESSION_TTL_MS;

  await db.collection('stars_payment_sessions').doc(sessionId).set({
    sessionId,
    userId,
    telegramUserId,
    plan,
    period,
    starsAmount,
    currency:  'XTR',
    status:    'created',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAtMs,
  });

  return { sessionId, starsAmount, payload: payloadFor(sessionId), expiresAtMs };
}

async function getPaymentSession(sessionId) {
  if (!sessionId) return null;
  const snap = await db.collection('stars_payment_sessions').doc(sessionId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

function isSessionExpired(session, nowMs = Date.now()) {
  return !session?.expiresAtMs || nowMs > session.expiresAtMs;
}

module.exports = {
  PAYLOAD_PREFIX,
  payloadFor,
  sessionIdFromPayload,
  createPaymentSession,
  getPaymentSession,
  isSessionExpired,
};
