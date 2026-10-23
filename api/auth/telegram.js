'use strict';

// Start-up cost of this function's modules (DEV-only timings, see below).
const MODULE_T0 = process.hrtime.bigint();
const BOOT_MS = process.uptime() * 1000;

const crypto = require('crypto');
const firebaseAdminModule = require('../_lib/firebaseAdmin');
const { admin, db } = firebaseAdminModule;
const { computeTrialWindow, buildTrialSubscription } = require('../_lib/subscription/plan');
const { createRequestTimer } = require('../_lib/serverTiming');

const MODULE_INIT_MS = Number(process.hrtime.bigint() - MODULE_T0) / 1e6;
const NO_TIMER = { phase() {}, time: (_name, fn) => fn() };

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
// steps 2-4 of the lookup above, factored out of resolveCanonicalUid for
// readability. Never touches canonicalUids — purely a read.
//
// `prefetched` holds what resolveCanonicalUid already read: the telegramUsers
// mapping, whether the account it points to exists, and the two chatId
// queries (started together with the first read, see below).
function readChatIdCandidates(telegramId) {
  return Promise.all([
    db.collection('users').where('chatId', '==', telegramId).get(),
    db.collection('users').where('chatId', '==', String(telegramId)).get(),
  ]);
}

async function gatherLiveCandidates(telegramId, prefetched) {
  const candidateUids = new Set();
  const addDocs = (snap) => { for (const d of snap.docs) candidateUids.add(d.id); };

  const [usersNumSnap, usersStrSnap] = await prefetched.chatIdQueries;

  addDocs(usersNumSnap);
  addDocs(usersStrSnap);

  const hadHistoricalMapping = prefetched.telegramUsersSnap.exists;
  if (hadHistoricalMapping) {
    const mappedUid = prefetched.telegramUsersSnap.data()?.firebaseUid;
    // Defensive: only trust this mapping if the account it points to
    // actually still exists (never resolve to an orphaned/deleted uid).
    if (mappedUid && prefetched.userExists(mappedUid)) candidateUids.add(mappedUid);
  }

  return { candidateUids, hadHistoricalMapping };
}

// Reading vs deciding. The documents every decision below may need are read
// in at most two round trips — (1) the manual link, the canonical cache and
// the telegramUsers mapping, and alongside them the two chatId queries (their
// result is only USED when the links below settle nothing; for an existing
// account they are two wasted reads, for a new one they save a round trip);
// (2) every account the links point to, with its subscription document,
// together. The decisions themselves are taken one at a time,
// in the same order of trust as always: a verified manual link first, then
// the canonical cache (only if its account still exists), then the live
// candidates — conflict, recovery_required and new exactly as before.
//
// options.timer      — DEV-only phase timings (serverTiming.js).
// options.deferCacheWrite — return the canonicalUids write as `cacheWrite`
//   (already started) instead of awaiting it, so the caller can run it next
//   to the account setup; the caller must await it before issuing a token.
// A 'unique' result also carries `subscriptionSnap` when the account's
// subscription document was read on the way (setupNewUserIfNeeded skips its
// transaction when that document exists).
async function resolveCanonicalUid(telegramId, options = {}) {
  const timer = options.timer || NO_TIMER;
  const manualRef = db.collection('telegramManualLinks').doc(`tg_${telegramId}`);
  const canonicalRef = db.collection('canonicalUids').doc(`tg_${telegramId}`);
  const telegramUsersRef = db.collection('telegramUsers').doc(`tg_${telegramId}`);

  const chatIdQueries = timer.time('candidates', () => readChatIdCandidates(telegramId));
  chatIdQueries.catch(() => {}); // awaited below only if needed; a failure there surfaces there
  const [manualLinkSnap, canonicalSnap, telegramUsersSnap] = await timer.time('links',
    () => db.getAll(manualRef, canonicalRef, telegramUsersRef));

  const manualData = manualLinkSnap.exists ? manualLinkSnap.data() : null;
  const manualUid = manualData?.verified === true && manualData?.uid ? manualData.uid : null;
  const cachedUid = canonicalSnap.exists ? canonicalSnap.data().uid : null;
  const mappedUid = telegramUsersSnap.exists ? telegramUsersSnap.data()?.firebaseUid || null : null;

  // Every account a stored link points to, and its subscription, in one read.
  const linkedUids = [...new Set([manualUid, cachedUid, mappedUid].filter(Boolean))];
  const accountSnaps = new Map();
  const subscriptionSnaps = new Map();
  if (linkedUids.length) {
    const snaps = await timer.time('accounts', () => db.getAll(
      ...linkedUids.map(uid => db.collection('users').doc(uid)),
      ...linkedUids.map(uid => db.collection('subscriptions').doc(uid)),
    ));
    linkedUids.forEach((uid, i) => {
      accountSnaps.set(uid, snaps[i]);
      subscriptionSnaps.set(uid, snaps[linkedUids.length + i]);
    });
  }
  const userExists = uid => accountSnaps.get(uid)?.exists === true;
  const unique = uid => ({ status: 'unique', uid, subscriptionSnap: subscriptionSnaps.get(uid) });

  // 0. Verified manual recovery link — authoritative, created ONLY by a
  // separate admin-gated recovery endpoint, never by this function. Checked
  // FIRST, before the ordinary canonicalUids cache, so a stale cache entry
  // can never shadow an explicit, verified recovery decision — this is
  // deliberately a DIFFERENT trust tier from
  // the ordinary cache below, not a variant of it (see
  // TELEGRAM_PASSWORDLESS_AUTOAUTH audit, targeted-recovery round §5/§6).
  //
  // A manual link whose target no longer exists is ignored entirely (never
  // trust a dangling manual link as a real answer), but its mere existence
  // is still definite proof this identity was seen and deliberately linked
  // before, same as an orphaned telegramUsers mapping — so a "zero live
  // candidates" outcome below still becomes recovery_required, never a
  // silent "new account" fallback.
  const hadVerifiedManualLink = !!manualUid;
  if (manualUid && userExists(manualUid)) return unique(manualUid);

  // 1. Canonical cache — trusted only while the account it names exists. A
  // stale entry falls through to a fresh resolution below; whatever that
  // resolves to overwrites it (conflict/recovery_required leave it alone).
  if (cachedUid && userExists(cachedUid)) return unique(cachedUid);

  const { candidateUids, hadHistoricalMapping } =
    await gatherLiveCandidates(telegramId, { telegramUsersSnap, userExists, chatIdQueries });

  const cache = (result) => {
    const write = canonicalRef.set({ uid: result.uid, telegramId, resolvedAt: admin.firestore.FieldValue.serverTimestamp() });
    if (options.deferCacheWrite) return { ...result, cacheWrite: write };
    return write.then(() => result);
  };

  if (candidateUids.size === 1) {
    const uid = [...candidateUids][0];
    return cache({ status: 'unique', uid, subscriptionSnap: subscriptionSnaps.get(uid) });
  }

  if (candidateUids.size > 1) {
    // Deliberately does NOT write to canonicalUids — an unresolved conflict
    // must never be cached as if it were a decision, and must stay
    // re-checkable (e.g. once an admin resolves the conflict some other way).
    return { status: 'conflict', uid: null };
  }

  // candidateUids.size === 0
  if (hadHistoricalMapping || hadVerifiedManualLink) {
    return { status: 'recovery_required', uid: null };
  }

  return cache({ status: 'new', uid: `tg_${telegramId}` });
}

// Observability events (TELEGRAM_PASSWORDLESS_AUTOAUTH audit §26) — plain
// console.log, safe fields only (booleans, the resolved reason/uid-is-new
// flag), never raw initData, tokens, or Telegram ids.
function logEvent(name, fields) {
  console.log(`[auth/telegram] ${name}`, fields ?? {});
}

async function telegramAuthHandler(req, res) {
  // DEV only: phase timings as Server-Timing plus one log line (names and
  // milliseconds, see serverTiming.js). Elsewhere this records nothing.
  const timer = createRequestTimer(req, {
    boot: BOOT_MS,
    modinit: MODULE_INIT_MS,
    ...(firebaseAdminModule.initTimings || {}),
  });
  const reply = (status, body, outcome) => {
    timer.finish(res, outcome);
    return res.status(status).json(body);
  };

  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' }, 'method');

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
    return reply(400, { error: 'Missing initData' }, 'rejected');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('[auth/telegram]', diag, { reason: 'server_misconfigured' });
    logEvent('telegram_autoauth_failed', { reason: 'server_misconfigured' });
    return reply(500, { error: 'Server misconfigured' }, 'error');
  }

  const verified = verifyInitData(initData, botToken);
  timer.phase('verify');
  diag.hmacValid = verified.ok || verified.reason !== 'bad_signature';
  diag.authDateValid = verified.ok || (verified.reason !== 'missing_auth_date' && verified.reason !== 'expired');
  if (!verified.ok) {
    console.log('[auth/telegram]', diag, { reason: verified.reason });
    logEvent('telegram_autoauth_failed', { reason: verified.reason });
    return reply(401, { error: 'Invalid initData signature' }, 'rejected');
  }
  const params = verified.params;

  let tgUser;
  try {
    tgUser = JSON.parse(params.get('user') || '{}');
  } catch {
    console.log('[auth/telegram]', diag, { reason: 'bad_user_payload' });
    logEvent('telegram_autoauth_failed', { reason: 'bad_user_payload' });
    return reply(400, { error: 'Invalid user payload' }, 'rejected');
  }

  const telegramId = tgUser.id;
  diag.telegramUserIdResolved = !!telegramId;
  if (!telegramId) {
    console.log('[auth/telegram]', diag);
    logEvent('telegram_autoauth_failed', { reason: 'missing_telegram_user_id' });
    return reply(400, { error: 'Missing user.id' }, 'rejected');
  }

  try {
    const resolution = await resolveCanonicalUid(telegramId, { timer, deferCacheWrite: true });

    if (resolution.status === 'conflict') {
      // Two or more distinct existing accounts map to this Telegram id.
      // Never auto-picked, never merged, never a new third account — see
      // TELEGRAM_PASSWORDLESS_AUTOAUTH audit §1/§8. No token is issued.
      logEvent('telegram_auth_identity_conflict');
      return reply(409, { error: 'identity_conflict', code: 'TELEGRAM_IDENTITY_CONFLICT' }, 'conflict');
    }

    if (resolution.status === 'recovery_required') {
      // We have definite evidence this Telegram id was linked before (a
      // telegramUsers mapping doc exists), but its target account isn't
      // resolvable right now. Creating a new account here would be exactly
      // the duplicate-account bug this whole effort exists to prevent — see
      // audit §10/§11. No token is issued.
      logEvent('telegram_auth_recovery_required');
      return reply(409, { error: 'recovery_required', code: 'TELEGRAM_ACCOUNT_RECOVERY_REQUIRED' }, 'recovery');
    }

    const uid = resolution.uid;
    const isNewIdentity = resolution.status === 'new';

    const startParam = params.get('start_param') || null;
    // The canonical cache write (when this resolution made one) and the
    // account setup touch different documents and run side by side; BOTH
    // must succeed before a token is issued — a failure of either is a 500
    // with no token, and the next attempt resolves the same uid again.
    const [, isNewUser] = await Promise.all([
      resolution.cacheWrite ? timer.time('cachewrite', () => resolution.cacheWrite) : null,
      timer.time('setup', () => setupNewUserIfNeeded(uid, tgUser, startParam, {
        subscriptionSnap: resolution.subscriptionSnap, likelyNew: isNewIdentity, timer,
      })),
    ]);
    const token = await timer.time('token', () => admin.auth().createCustomToken(uid));
    diag.enmaUserResolved = true;
    console.log('[auth/telegram]', diag, { isNewUser });
    logEvent(isNewIdentity ? 'telegram_autoauth_new_user' : 'telegram_autoauth_existing_user');
    logEvent('telegram_autoauth_success');
    return reply(200, { token, uid, isNewUser }, isNewUser ? 'new_account' : 'existing_account');
  } catch (err) {
    console.error('[auth/telegram] error', err);
    logEvent('telegram_autoauth_failed', { reason: 'server_error' });
    return reply(500, { error: 'Auth failed' }, 'error');
  }
}

// options.subscriptionSnap — the subscription document as already read by
// resolveCanonicalUid. When it exists the transaction below could only read it
// and return false, so it is skipped (the referral step above still runs, as
// before).
// options.likelyNew — the identity resolved as never seen before: first try to
// create the user and the trial in one atomic batch whose writes each require
// the document NOT to exist (create). If either exists already — a concurrent
// launch got there first, or the referral step wrote users/{uid} — the whole
// batch is refused and the transaction below decides, exactly as before.
// Either way a user and a trial are created at most once.
async function setupNewUserIfNeeded(uid, tgUser, startParam, options = {}) {
  const timer = options.timer || NO_TIMER;
  const userRef = db.collection('users').doc(uid);
  const subRef  = db.collection('subscriptions').doc(uid);

  // Process referral link regardless of new/existing user (attributeReferral is
  // idempotent). This IS the real "registration" moment for the deep-link
  // funnel: a Mini App launch is the only way a brand-new Enma account gets
  // created, so this is where a partner's "click" becomes a "registration".
  // It stays BEFORE the transaction: consumer referrals only count while the
  // users/{uid} document does not exist yet.
  if (startParam && startParam.startsWith('ref_')) {
    const refCode = startParam.slice(4);
    const { attributeReferral } = require('../_lib/referral/partners');
    await timer.time('referral', () => attributeReferral(uid, refCode, { chatId: tgUser.id }).catch(err =>
      console.error('[auth/telegram] referral start error:', err.message)
    ));
  }

  if (options.subscriptionSnap && options.subscriptionSnap.exists) return false;

  const trialWindow = computeTrialWindow(new Date());
  const newUserDoc = () => ({
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

  if (options.likelyNew) {
    const batch = db.batch();
    batch.create(userRef, newUserDoc());
    batch.create(subRef, buildTrialSubscription(uid, trialWindow, admin.firestore.FieldValue.serverTimestamp()));
    try {
      await timer.time('create', () => batch.commit());
      return true;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // Something exists already: the transaction below reads and decides.
    }
  }

  // The exists-check now happens INSIDE the transaction (tx.getAll, not a
  // pre-fetched snapshot) — see TELEGRAM_PASSWORDLESS_AUTOAUTH audit §7/§10:
  // two concurrent Mini App launches for the same brand-new Telegram user
  // both resolve to the same deterministic uid (resolveCanonicalUid), and
  // this transaction is what stops them from racing to double-write the
  // trial subscription — whichever commits first wins, the other's read
  // sees subSnap.exists === true and bails out as a no-op. Both documents are
  // read in one call (two separate reads cost a round trip each).
  return db.runTransaction(async tx => {
    const [userSnap, subSnap] = await tx.getAll(userRef, subRef);

    if (subSnap.exists) return false;

    if (!userSnap.exists) {
      tx.set(userRef, newUserDoc());
    } else {
      tx.update(userRef, { trialUsed: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    tx.set(subRef, buildTrialSubscription(uid, trialWindow, admin.firestore.FieldValue.serverTimestamp()));

    return true;
  });
}

// Firestore's ALREADY_EXISTS (gRPC code 6), as raised by a refused create().
function isAlreadyExists(err) {
  return !!err && (err.code === 6 || err.code === 'already-exists' || /ALREADY_EXISTS/.test(String(err.message)));
}

module.exports = telegramAuthHandler;
// Named exports purely for unit testing (see __tests__/telegram.test.js) —
// Vercel's runtime only ever calls module.exports() itself, same as before.
module.exports.verifyInitData = verifyInitData;
module.exports.resolveCanonicalUid = resolveCanonicalUid;
module.exports.setupNewUserIfNeeded = setupNewUserIfNeeded;
