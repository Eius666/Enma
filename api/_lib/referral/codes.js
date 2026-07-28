'use strict';

const { db, admin } = require('../firebaseAdmin');

// Unambiguous characters (no 0/O, 1/I/l)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateCode(length = 8) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

// Ensure the user has a referral code. Creates one if missing.
async function ensureReferralCode(userId) {
  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return null;

  const data = userDoc.data();
  if (data.referralCode) return data.referralCode;

  let code;
  let attempts = 0;
  while (attempts < 10) {
    code = generateCode(8);
    const dup = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (dup.empty) break;
    attempts++;
  }
  if (!code) return null;

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'EnmaAI_bot';
  const referralLink = `https://t.me/${botUsername}?start=ref_${code}`;

  await userRef.set({
    referralCode: code,
    referralLink,
    totalEarningsUsd:    data.totalEarningsUsd    ?? 0,
    totalPaidUsd:        data.totalPaidUsd         ?? 0,
    pendingPayoutUsd:    data.pendingPayoutUsd      ?? 0,
    tonWalletAddress:    data.tonWalletAddress      ?? null,
    referredBy:          data.referredBy            ?? null,
    referralLinkClaimedAt: data.referralLinkClaimedAt ?? null,
  }, { merge: true });

  return code;
}

// Find user doc by referral code
async function findUserByReferralCode(code) {
  const snap = await db.collection('users').where('referralCode', '==', code).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Create referral relationship when a user clicks a referral link.
// Returns { ok, reason?, referrerName? }
async function handleReferralStart(referredUserId, referralCode) {
  const referrer = await findUserByReferralCode(referralCode);
  if (!referrer) return { ok: false, reason: 'invalid_code' };
  if (referrer.id === referredUserId) return { ok: false, reason: 'self_referral' };

  const existing = await db.collection('referrals')
    .where('referredId', '==', referredUserId)
    .limit(1)
    .get();
  if (!existing.empty) return { ok: false, reason: 'already_referred' };

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.collection('referrals').add({
    referrerId: referrer.id,
    referredId: referredUserId,
    status: 'pending',
    referralLinkExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: now,
    convertedAt: null,
    cancelledAt: null,
  });

  await db.collection('users').doc(referredUserId).set(
    { referredBy: referralCode, referralLinkClaimedAt: now },
    { merge: true }
  );

  // Notify the referrer
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const referrerChatId = referrer.chatId;
  if (token && referrerChatId) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: referrerChatId,
        text: '👋 По твоей реферальной ссылке зарегистрировался новый пользователь!',
      }),
    }).catch(() => {});
  }

  const referrerName = referrer.firstName || referrer.displayName || 'пользователь';
  return { ok: true, referrerName };
}

module.exports = { ensureReferralCode, findUserByReferralCode, handleReferralStart };
