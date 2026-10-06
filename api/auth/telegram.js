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

// Exhaustive existing-account lookup for a verified Telegram user id. Tries
// every mapping this project's real schema has ever used (audited, not
// guessed — see TELEGRAM_PASSWORDLESS_AUTOAUTH audit §4/§5) before ever
// falling back to creating a new account:
//
//   1. canonicalUids/tg_<id>      — fast path, but only trusted after
//                                   re-verifying the cached uid still
//                                   exists (a stale cache entry — the
//                                   production audit's missingUidMapping
//                                   count — must never be trusted blindly;
//                                   it self-heals here instead of needing
//                                   a separate migration write)
//   2. telegramUsers/tg_<id>      — written by the frontend (App.tsx) for
//                                   ANY authenticated session that also has
//                                   Telegram context, including users who
//                                   originally signed up by email/password
//   3. users where chatId == <id>          (number — the common case)
//   4. users where chatId == String(<id>)  (string — webhook.js's own [5]
//                                   USER LOOKUP has carried this exact
//                                   fallback for a long time, proving some
//                                   existing user docs really do have a
//                                   string-typed chatId)
//
// Returns { status, uid }:
//   'unique'            — exactly one existing account matched; uid is set,
//                          safe to sign in.
//   'conflict'          — two or more DISTINCT existing accounts matched;
//                          uid is null. Never auto-picked, never merged,
//                          never a new third account — see
//                          TELEGRAM_PASSWORDLESS_AUTOAUTH audit §1/§8. The
//                          caller returns a controlled
//                          TELEGRAM_IDENTITY_CONFLICT response instead of a
//                          token.
//   'recovery_required' — zero CURRENT candidates, but a telegramUsers
//                          mapping doc exists for this Telegram id (i.e. we
//                          have definite evidence this identity was seen
//                          and linked before — its target account just
//                          isn't resolvable right now, e.g. deleted). Never
//                          creates a new account for this case — see
//                          audit §10/§11 ("видел раньше, но не могу
//                          восстановить" must never fall through to
//                          "truly new"). uid is null; the caller returns
//                          TELEGRAM_ACCOUNT_RECOVERY_REQUIRED.
//   'new'                — zero candidates AND no historical mapping of any
//                          kind — this Telegram id has genuinely never been
//                          seen before. Safe to create a fresh account.
// The live, authoritative "who could this Telegram id possibly be" check —
// steps 2-4 of the lookup above, factored out so the one-time migration
// APPLY logic (api/ai/[action].js's adminTelegramMappingApply) can re-verify
// a candidate immediately before writing using the EXACT same logic the
// live auth path uses, instead of a separate reimplementation that could
// silently drift out of sync. Never touches canonicalUids — purely a read.
async function gatherLiveCandidates(telegramId) {
  const candidateUids = new Set();
  const addDocs = (snap) => { for (const d of snap.docs) candidateUids.add(d.id); };

  const [telegramUsersSnap, usersNumSnap, usersStrSnap] = await Promise.all([
    db.collection('telegramUsers').doc(`tg_${telegramId}`).get(),
    db.collection('users').where('chatId', '==', telegramId).get(),
    db.collection('users').where('chatId', '==', String(telegramId)).get(),
  ]);

  addDocs(usersNumSnap);
  addDocs(usersStrSnap);

  const hadHistoricalMapping = telegramUsersSnap.exists;
  if (hadHistoricalMapping) {
    const mappedUid = telegramUsersSnap.data()?.firebaseUid;
    if (mappedUid) {
      // Defensive: only trust this mapping if the account it points to
      // actually still exists (never resolve to an orphaned/deleted uid).
      const mappedUserSnap = await db.collection('users').doc(mappedUid).get();
      if (mappedUserSnap.exists) candidateUids.add(mappedUid);
    }
  }

  return { candidateUids, hadHistoricalMapping };
}

async function resolveCanonicalUid(telegramId) {
  const canonicalRef = db.collection('canonicalUids').doc(`tg_${telegramId}`);
  const canonicalSnap = await canonicalRef.get();
  if (canonicalSnap.exists) {
    const cachedUid = canonicalSnap.data().uid;
    const cachedUserSnap = await db.collection('users').doc(cachedUid).get();
    if (cachedUserSnap.exists) {
      return { status: 'unique', uid: cachedUid };
    }
    // Stale cache entry (the account it names no longer exists) — fall
    // through to a fresh resolution below instead of trusting it. Whatever
    // this resolves to now will overwrite (or, for conflict/recovery_required,
    // simply not touch) this stale doc.
  }

  const { candidateUids, hadHistoricalMapping } = await gatherLiveCandidates(telegramId);

  if (candidateUids.size === 1) {
    const uid = [...candidateUids][0];
    await canonicalRef.set({ uid, telegramId, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { status: 'unique', uid };
  }

  if (candidateUids.size > 1) {
    // Deliberately does NOT write to canonicalUids — an unresolved conflict
    // must never be cached as if it were a decision, and must stay
    // re-checkable (e.g. once an admin resolves the conflict some other way).
    return { status: 'conflict', uid: null };
  }

  // candidateUids.size === 0
  if (hadHistoricalMapping) {
    return { status: 'recovery_required', uid: null };
  }

  const newUid = `tg_${telegramId}`;
  await canonicalRef.set({ uid: newUid, telegramId, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { status: 'new', uid: newUid };
}

// Observability events (TELEGRAM_PASSWORDLESS_AUTOAUTH audit §26) — plain
// console.log, safe fields only (booleans, the resolved reason/uid-is-new
// flag), never raw initData, tokens, or Telegram ids.
function logEvent(name, fields) {
  console.log(`[auth/telegram] ${name}`, fields ?? {});
}

async function telegramAuthHandler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  logEvent('telegram_autoauth_started');

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
    logEvent('telegram_autoauth_failed', { reason: 'missing_init_data' });
    return res.status(400).json({ error: 'Missing initData' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[auth/telegram]', diag, { reason: 'server_misconfigured' });
    logEvent('telegram_autoauth_failed', { reason: 'server_misconfigured' });
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const verified = verifyInitData(initData, botToken);
  diag.hmacValid = verified.ok || verified.reason !== 'bad_signature';
  diag.authDateValid = verified.ok || (verified.reason !== 'missing_auth_date' && verified.reason !== 'expired');
  if (!verified.ok) {
    console.log('[auth/telegram]', diag, { reason: verified.reason });
    logEvent('telegram_autoauth_failed', { reason: verified.reason });
    return res.status(401).json({ error: 'Invalid initData signature' });
  }
  const params = verified.params;

  let tgUser;
  try {
    tgUser = JSON.parse(params.get('user') || '{}');
  } catch {
    console.log('[auth/telegram]', diag, { reason: 'bad_user_payload' });
    logEvent('telegram_autoauth_failed', { reason: 'bad_user_payload' });
    return res.status(400).json({ error: 'Invalid user payload' });
  }

  const telegramId = tgUser.id;
  diag.telegramUserIdResolved = !!telegramId;
  if (!telegramId) {
    console.log('[auth/telegram]', diag);
    logEvent('telegram_autoauth_failed', { reason: 'missing_telegram_user_id' });
    return res.status(400).json({ error: 'Missing user.id' });
  }

  try {
    const resolution = await resolveCanonicalUid(telegramId);

    if (resolution.status === 'conflict') {
      // Two or more distinct existing accounts map to this Telegram id.
      // Never auto-picked, never merged, never a new third account — see
      // TELEGRAM_PASSWORDLESS_AUTOAUTH audit §1/§8. No token is issued.
      logEvent('telegram_auth_identity_conflict');
      return res.status(409).json({ error: 'identity_conflict', code: 'TELEGRAM_IDENTITY_CONFLICT' });
    }

    if (resolution.status === 'recovery_required') {
      // We have definite evidence this Telegram id was linked before (a
      // telegramUsers mapping doc exists), but its target account isn't
      // resolvable right now. Creating a new account here would be exactly
      // the duplicate-account bug this whole effort exists to prevent — see
      // audit §10/§11. No token is issued.
      logEvent('telegram_auth_recovery_required');
      return res.status(409).json({ error: 'recovery_required', code: 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED' });
    }

    const uid = resolution.uid;
    const isNewIdentity = resolution.status === 'new';

    const startParam = params.get('start_param') || null;
    const isNewUser  = await setupNewUserIfNeeded(uid, tgUser, startParam);
    const token      = await admin.auth().createCustomToken(uid);
    diag.enmaUserResolved = true;
    console.log('[auth/telegram]', diag, { isNewUser });
    logEvent(isNewIdentity ? 'telegram_autoauth_new_user' : 'telegram_autoauth_existing_user');
    logEvent('telegram_autoauth_success');
    return res.status(200).json({ token, uid, isNewUser });
  } catch (err) {
    console.error('[auth/telegram] error', err);
    logEvent('telegram_autoauth_failed', { reason: 'server_error' });
    return res.status(500).json({ error: 'Auth failed' });
  }
}

const TRIAL_DAYS = 7;

async function setupNewUserIfNeeded(uid, tgUser, startParam) {
  const userRef = db.collection('users').doc(uid);
  const subRef  = db.collection('subscriptions').doc(uid);

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

  const now      = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
  trialEnd.setHours(23, 59, 59, 999);

  // The exists-check now happens INSIDE the transaction (tx.get, not a
  // pre-fetched snapshot) — see TELEGRAM_PASSWORDLESS_AUTOAUTH audit §7/§10:
  // two concurrent Mini App launches for the same brand-new Telegram user
  // both resolve to the same deterministic uid (resolveCanonicalUid), and
  // this transaction is what stops them from racing to double-write the
  // trial subscription — whichever commits first wins, the other's tx.get
  // sees subSnap.exists === true and bails out as a no-op.
  return db.runTransaction(async tx => {
    const [userSnap, subSnap] = await Promise.all([tx.get(userRef), tx.get(subRef)]);

    if (subSnap.exists) return false;

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

    return true;
  });
}

module.exports = telegramAuthHandler;
// Named exports for unit testing AND for adminTelegramMappingApply's
// re-verification step (api/ai/[action].js) to reuse the exact same
// candidate-resolution logic the live auth path uses — Vercel's runtime
// only ever calls module.exports() itself, same as before.
module.exports.verifyInitData = verifyInitData;
module.exports.resolveCanonicalUid = resolveCanonicalUid;
module.exports.setupNewUserIfNeeded = setupNewUserIfNeeded;
module.exports.gatherLiveCandidates = gatherLiveCandidates;
