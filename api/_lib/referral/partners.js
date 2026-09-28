'use strict';

// ── Partner (affiliate) program — identity, tracking links, attribution ─────
//
// Builds on the existing `referrers` collection (admin-managed "influencer"
// codes, see influencer.js for the commission math) rather than inventing a
// parallel system. What this file adds on top of it:
//
//   • self-service signup (a code created from a Telegram Login Widget
//     identity instead of typed by an admin)
//   • deep-link click/registration counters, overall AND per platform
//     (Telegram / YouTube / VK / Instagram / other), so the partner
//     dashboard can show a real clicks→registrations→payments funnel
//   • a single parser+dispatcher for the `ref_...` start-param so Telegram
//     bot, the Mini App auth endpoint and the web checkout page all resolve
//     a link the same way, instead of three separate implementations
//
// Attribution model (per user decision): Telegram-only. A "click" is a
// distinct Telegram chat opening `t.me/BOT?start=ref_CODE[_platform]`; a
// "registration" is that same chat completing Enma's real sign-up (the Mini
// App call to /api/auth/telegram — see attributeReferral's caller there).
// There is no way to count a click before the visitor reaches Telegram.

const { db, admin } = require('../firebaseAdmin');
const { findUserByReferralCode, handleReferralStart } = require('./codes');
const { recordInfluencerReferral } = require('./influencer');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, matches codes.js's ambiguity rule
const CODE_LEN = 6;
const PLATFORMS = new Set(['tg', 'yt', 'vk', 'ig', 'src']);
const DEFAULT_PLATFORM = 'direct';

function randomCode(len = CODE_LEN) {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

// Partner codes are plain uppercase alnum (no underscore) so `CODE_platform`
// splits unambiguously on the first underscore.
async function generateUniquePartnerCode() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = randomCode();
    const snap = await db.collection('referrers').doc(code).get();
    if (!snap.exists) return code;
  }
  throw new Error('Could not generate a unique partner code');
}

function botUsername() {
  return process.env.TELEGRAM_BOT_USERNAME || 'EnmaAI_bot';
}

function normalizePlatform(p) {
  const lower = String(p || '').toLowerCase();
  return PLATFORMS.has(lower) ? lower : DEFAULT_PLATFORM;
}

function linkFor(code, platform) {
  const p = normalizePlatform(platform);
  const start = p === DEFAULT_PLATFORM ? `ref_${code}` : `ref_${code}_${p}`;
  return `https://t.me/${botUsername()}?start=${start}`;
}

// ── Identity: find-or-create a partner from a verified Telegram login ───────

async function findOrCreatePartnerByTelegram(tgUser) {
  const existing = await db.collection('referrers')
    .where('telegramId', '==', tgUser.id)
    .limit(1)
    .get();
  if (!existing.empty) {
    const doc = existing.docs[0];
    return { code: doc.id, ...doc.data() };
  }

  const code = await generateUniquePartnerCode();
  const name = [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' ').trim() ||
    tgUser.username || `Partner ${code}`;

  const doc = {
    code,
    name,
    telegramId: tgUser.id,
    telegramUsername: tgUser.username || '',
    commissionPercent: 30,
    discountPercent: 10,
    status: 'active',
    source: 'self_service',
    clicks: 0,
    registrations: 0,
    totalEarned: 0,
    pendingPayout: 0,
    paidOut: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await db.collection('referrers').doc(code).set(doc);
  return { code, ...doc };
}

// ── Deep-link parsing ─────────────────────────────────────────────────────────

// "CODE" or "CODE_platform" -> { code, platform }. Partner codes never
// contain underscores (see randomCode), so splitting on the FIRST one is safe.
function splitCodeAndPlatform(raw) {
  const i = raw.indexOf('_');
  if (i === -1) return { code: raw, platform: DEFAULT_PLATFORM };
  return { code: raw.slice(0, i), platform: normalizePlatform(raw.slice(i + 1)) };
}

// Classifies a raw `ref_...` payload (already stripped of the `ref_` prefix)
// without doing any writes. Consumer codes (users.referralCode) are checked
// first, byte-exact — they're generated from a mixed-case alphabet, so a
// case-sensitive match is the correct (and cheap) way to try them first.
async function resolveReferralParam(rawParam) {
  if (!rawParam) return { kind: 'invalid' };

  const consumerReferrer = await findUserByReferralCode(rawParam);
  if (consumerReferrer) return { kind: 'consumer', code: rawParam };

  const { code, platform } = splitCodeAndPlatform(rawParam.toUpperCase());
  const partnerSnap = await db.collection('referrers').doc(code).get();
  if (partnerSnap.exists) return { kind: 'partner', code, platform };

  return { kind: 'invalid' };
}

// Records a Telegram-side click for a partner link, deduped per chat so
// repeatedly pressing "Start" never inflates the count. Safe to call before
// any Enma account exists for this chat — that's the whole point.
async function recordPartnerClick(chatId, code, platform) {
  const markerRef = db.collection('referrers').doc(code).collection('clickLog').doc(String(chatId));
  const marker = await markerRef.get();
  if (marker.exists) return { counted: false };

  const p = normalizePlatform(platform);
  const linkRef = db.collection('referrers').doc(code).collection('links').doc(p);
  const referrerRef = db.collection('referrers').doc(code);

  await db.runTransaction(async (tx) => {
    tx.set(markerRef, { platform: p, at: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(referrerRef, { clicks: admin.firestore.FieldValue.increment(1) }, { merge: true });
    tx.set(linkRef, {
      platform: p,
      clicks: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
  });
  return { counted: true };
}

// The single place every entry point (Mini App auth, Telegram bot re-entry,
// web checkout) calls to resolve a `ref_...` start param for an
// AUTHENTICATED uid. Idempotent — safe to call on every /start.
//   uid — the Enma user this attribution applies to (their account may have
//         just been created this same request)
//   chatId — used only for partner click accounting; optional
// Returns { ok, kind:'consumer'|'partner', reason? }
async function attributeReferral(uid, rawParam, { chatId } = {}) {
  const resolved = await resolveReferralParam(rawParam);

  if (resolved.kind === 'consumer') {
    const result = await handleReferralStart(uid, resolved.code);
    return { ok: result.ok, kind: 'consumer', reason: result.reason, referrerName: result.referrerName };
  }

  if (resolved.kind === 'partner') {
    if (chatId != null) {
      await recordPartnerClick(chatId, resolved.code, resolved.platform).catch(() => {});
    }
    const result = await recordInfluencerReferral(uid, resolved.code, resolved.platform);
    return { ok: !!result, kind: 'partner', code: resolved.code, alreadyReferred: !result };
  }

  return { ok: false, kind: 'invalid', reason: 'invalid_code' };
}

// ── Dashboard read model ─────────────────────────────────────────────────────

async function getOrCreateTrackingLink(code, platform) {
  const p = normalizePlatform(platform);
  const ref = db.collection('referrers').doc(code).collection('links').doc(p);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ platform: p, clicks: 0, registrations: 0, payments: 0, commission: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return { platform: p, url: linkFor(code, p) };
}

async function getPartnerSummary(code) {
  const refDoc = await db.collection('referrers').doc(code).get();
  if (!refDoc.exists) return null;
  const referrer = refDoc.data();

  const [linksSnap, earningsSnap] = await Promise.all([
    db.collection('referrers').doc(code).collection('links').get(),
    db.collection('referralEarnings').where('referrerId', '==', code).orderBy('createdAt', 'desc').limit(50).get(),
  ]);

  const links = linksSnap.docs.map((d) => ({ id: d.id, url: linkFor(code, d.id), ...d.data() }));
  const earnings = earningsSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      amount: data.amount,
      commission: data.commission,
      status: data.status,
      platform: data.platform || DEFAULT_PLATFORM,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null,
    };
  });

  const payments = earnings.filter((e) => e.status !== 'cancelled').length;

  return {
    code,
    name: referrer.name || '',
    status: referrer.status || 'active',
    commissionPercent: referrer.commissionPercent ?? 30,
    discountPercent: referrer.discountPercent ?? 10,
    clicks: referrer.clicks || 0,
    registrations: referrer.registrations || 0,
    payments,
    totalEarned: referrer.totalEarned || 0,
    pendingPayout: referrer.pendingPayout || 0,
    paidOut: referrer.paidOut || 0,
    defaultLink: linkFor(code, DEFAULT_PLATFORM),
    links,
    recentEarnings: earnings.slice(0, 20),
  };
}

module.exports = {
  PLATFORMS,
  DEFAULT_PLATFORM,
  linkFor,
  normalizePlatform,
  splitCodeAndPlatform,
  generateUniquePartnerCode,
  findOrCreatePartnerByTelegram,
  resolveReferralParam,
  recordPartnerClick,
  attributeReferral,
  getOrCreateTrackingLink,
  getPartnerSummary,
};
