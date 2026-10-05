'use strict';

const crypto = require('crypto');
const { admin, db } = require('../_lib/firebaseAdmin');

// Same freshness window as the (separate, Login-Widget-specific) check in
// _lib/referral/partnerAuth.js — Telegram's own recommended practice for
// both of its two distinct initData-signing schemes.
const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

// Returns { ok, params?, reason? }. `reason` is one of 'missing_hash',
// 'bad_signature', 'missing_auth_date', 'expired' — safe to log, never the
// initData itself.
function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing_hash' };

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  let validSignature = false;
  try {
    validSignature = hash.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    validSignature = false;
  }
  if (!validSignature) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'missing_auth_date' };
  if (Math.abs(Date.now() / 1000 - authDate) > INIT_DATA_MAX_AGE_S) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, params };
}

async function resolveCanonicalUid(telegramId, chatId) {
  // 1. Check if canonical UID already assigned
  const canonicalRef = db.collection('canonicalUids').doc(`tg_${telegramId}`);
  const canonicalSnap = await canonicalRef.get();
  if (canonicalSnap.exists) {
    return canonicalSnap.data().uid;
  }

  // 2. Find all existing Firebase UIDs for this Telegram user
  const usersSnap = await db.collection('users')
    .where('chatId', '==', chatId)
    .get();

  let chosenUid = null;

  if (!usersSnap.empty) {
    // Prefer UID with active subscription; fallback to most recently updated
    let bestWithSub = null;
    let bestUpdatedAt = null;
    let bestNoSub = null;

    for (const userDoc of usersSnap.docs) {
      const data = userDoc.data();
      const updatedAt = data.updatedAt?.toMillis?.() ?? 0;
      const sub = data.subscription;
      const isPro = data.isPro === true;
      const isActive = isPro && sub?.status === 'active' && sub?.endDate && new Date(sub.endDate) > new Date();

      if (isActive) {
        if (!bestWithSub || updatedAt > bestUpdatedAt) {
          bestWithSub = userDoc.id;
          bestUpdatedAt = updatedAt;
        }
      } else {
        if (!bestNoSub || updatedAt > (bestNoSub.updatedAt ?? 0)) {
          bestNoSub = { uid: userDoc.id, updatedAt };
        }
      }
    }

    chosenUid = bestWithSub ?? bestNoSub?.uid ?? null;
  }

  // 3. Fall back to new deterministic UID
  if (!chosenUid) {
    chosenUid = `tg_${telegramId}`;
  }

  // 4. Persist canonical mapping
  await canonicalRef.set({ uid: chosenUid, telegramId, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });

  return chosenUid;
}

async function telegramAuthHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Safe structured log — booleans and non-secret ids only. Never the raw
  // initData string, the bot token, or the signed custom token. See
  // TELEGRAM_AUTOLOGIN audit §7.
  const diag = {
    initDataReceived: false,
    hmacValid: false,
    authDateValid: false,
    telegramUserIdResolved: false,
    enmaUserResolved: false,
  };

  const { initData } = req.body ?? {};
  diag.initDataReceived = !!initData && typeof initData === 'string';
  if (!diag.initDataReceived) {
    console.log('[auth/telegram]', diag);
    return res.status(400).json({ error: 'Missing initData' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[auth/telegram]', diag, { reason: 'server_misconfigured' });
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const verified = verifyInitData(initData, botToken);
  diag.hmacValid = verified.ok || verified.reason !== 'bad_signature';
  diag.authDateValid = verified.ok || (verified.reason !== 'missing_auth_date' && verified.reason !== 'expired');
  if (!verified.ok) {
    console.log('[auth/telegram]', diag, { reason: verified.reason });
    return res.status(401).json({ error: 'Invalid initData signature' });
  }
  const params = verified.params;

  let tgUser;
  try {
    tgUser = JSON.parse(params.get('user') || '{}');
  } catch {
    console.log('[auth/telegram]', diag, { reason: 'bad_user_payload' });
    return res.status(400).json({ error: 'Invalid user payload' });
  }

  const telegramId = tgUser.id;
  diag.telegramUserIdResolved = !!telegramId;
  if (!telegramId) {
    console.log('[auth/telegram]', diag);
    return res.status(400).json({ error: 'Missing user.id' });
  }

  try {
    const uid        = await resolveCanonicalUid(telegramId, telegramId);
    const startParam = params.get('start_param') || null;
    const isNewUser  = await setupNewUserIfNeeded(uid, tgUser, startParam);
    const token      = await admin.auth().createCustomToken(uid);
    diag.enmaUserResolved = true;
    console.log('[auth/telegram]', diag, { isNewUser });
    return res.status(200).json({ token, uid, isNewUser });
  } catch (err) {
    console.error('[auth/telegram] error', err);
    return res.status(500).json({ error: 'Auth failed' });
  }
}

const TRIAL_DAYS = 7;

async function setupNewUserIfNeeded(uid, tgUser, startParam) {
  const userRef = db.collection('users').doc(uid);
  const subRef  = db.collection('subscriptions').doc(uid);

  const [userSnap, subSnap] = await Promise.all([userRef.get(), subRef.get()]);

  // Process referral link regardless of new/existing user (attributeReferral is
  // idempotent). This IS the real "registration" moment for the deep-link
  // funnel: a Mini App launch is the only way a brand-new Enma account gets
  // created, so this is where a partner's "click" becomes a "registration".
  if (startParam && startParam.startsWith('ref_')) {
    const refCode = startParam.slice(4);
    const { attributeReferral } = require('../_lib/referral/partners');
    await attributeReferral(uid, refCode, { chatId: tgUser.id }).catch(err =>
      console.error('[auth/telegram] referral start error:', err.message)
    );
  }

  if (subSnap.exists) return false;

  const now      = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
  trialEnd.setHours(23, 59, 59, 999);

  await db.runTransaction(async tx => {
    if (!userSnap.exists) {
      tx.set(userRef, {
        uid,
        telegramId: tgUser.id,
        chatId:     tgUser.id,
        firstName:  tgUser.first_name ?? '',
        lastName:   tgUser.last_name  ?? '',
        username:   tgUser.username   ?? '',
        isPro:      false,
        trialUsed:  true,
        createdAt:  admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      tx.update(userRef, { trialUsed: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    tx.set(subRef, {
      id:              `trial_${uid}`,
      userId:           uid,
      plan:             'free',
      trialPlan:        'premium',
      period:           'month',
      status:           'active',
      startDate:        now.toISOString(),
      endDate:          trialEnd.toISOString(),
      endDateMs:        trialEnd.getTime(),
      trialEndDate:     trialEnd.toISOString(),
      trialEndDateMs:   trialEnd.getTime(),
      paymentMethod:    'trial',
      createdAt:        now.toISOString(),
      updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return true;
}

module.exports = telegramAuthHandler;
// Named export purely for unit testing (see __tests__/telegram.test.js) —
// Vercel's runtime only ever calls module.exports() itself, same as before.
module.exports.verifyInitData = verifyInitData;
