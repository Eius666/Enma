'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');

const MODULE_PATHS = [
  '../partners',
  '../influencer',
  '../codes',
];

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const p of MODULE_PATHS) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

const PARTNER = {
  code: 'SASHA1',
  name: 'Sasha',
  status: 'active',
  commissionPercent: 30,
  discountPercent: 10,
  clicks: 0,
  registrations: 0,
  totalEarned: 0,
  pendingPayout: 0,
  paidOut: 0,
};

// ── Code generation ──────────────────────────────────────────────────────────

test('generateUniquePartnerCode: 6 uppercase unambiguous chars, retries on collision', async () => {
  const db = injectMockDb({ 'referrers/AAAAAA': { code: 'AAAAAA' } });
  try {
    const { generateUniquePartnerCode } = require('../partners');
    let calls = 0;
    const origRandom = Math.random;
    // Force the first attempt to collide with the seeded doc, then succeed.
    Math.random = () => { calls++; return calls === 1 ? 0 : 0.5; };
    try {
      // With Math.random()===0 every char picks index 0 of CODE_CHARS ('A'),
      // producing 'AAAAAA' which already exists -> must retry, not throw.
      const code = await generateUniquePartnerCode();
      assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    } finally { Math.random = origRandom; }
  } finally { teardown(); }
});

// ── Deep-link parsing ─────────────────────────────────────────────────────────

test('splitCodeAndPlatform: plain code has no platform; suffix is recognised', () => {
  const db = injectMockDb({});
  try {
    const { splitCodeAndPlatform } = require('../partners');
    assert.deepEqual(splitCodeAndPlatform('SASHA1'), { code: 'SASHA1', platform: 'direct' });
    assert.deepEqual(splitCodeAndPlatform('SASHA1_TG'), { code: 'SASHA1', platform: 'tg' });
    assert.deepEqual(splitCodeAndPlatform('SASHA1_YT'), { code: 'SASHA1', platform: 'yt' });
    assert.deepEqual(splitCodeAndPlatform('SASHA1_BOGUS'), { code: 'SASHA1', platform: 'direct' });
  } finally { teardown(); }
});

test('resolveReferralParam: classifies consumer codes, partner codes and invalid input', async () => {
  const db = injectMockDb({
    'users/consumer1': { referralCode: 'AbCdEfGh' },
    'referrers/SASHA1': { ...PARTNER },
  });
  try {
    const { resolveReferralParam } = require('../partners');
    assert.deepEqual(await resolveReferralParam('AbCdEfGh'), { kind: 'consumer', code: 'AbCdEfGh' });
    assert.deepEqual(await resolveReferralParam('sasha1'), { kind: 'partner', code: 'SASHA1', platform: 'direct' });
    assert.deepEqual(await resolveReferralParam('sasha1_yt'), { kind: 'partner', code: 'SASHA1', platform: 'yt' });
    assert.deepEqual(await resolveReferralParam('nope'), { kind: 'invalid' });
    assert.deepEqual(await resolveReferralParam(''), { kind: 'invalid' });
  } finally { teardown(); }
});

// ── Click tracking ────────────────────────────────────────────────────────────

test('recordPartnerClick: counts once per chat, ignores repeat /start presses', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER } });
  try {
    const { recordPartnerClick } = require('../partners');
    const r1 = await recordPartnerClick(111, 'SASHA1', 'tg');
    const r2 = await recordPartnerClick(111, 'SASHA1', 'tg');
    const r3 = await recordPartnerClick(222, 'SASHA1', 'tg'); // different chat -> counts
    assert.equal(r1.counted, true);
    assert.equal(r2.counted, false);
    assert.equal(r3.counted, true);
    assert.equal(db._get('referrers/SASHA1').clicks, 2);
    assert.equal(db._get('referrers/SASHA1/links/tg').clicks, 2);
  } finally { teardown(); }
});

// ── Unified attribution dispatcher ───────────────────────────────────────────

test('attributeReferral: partner code attributes the user and records the platform', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER } });
  try {
    const { attributeReferral } = require('../partners');
    const r = await attributeReferral('newUid', 'sasha1_yt', { chatId: 777 });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'partner');
    assert.equal(db._get('users/newUid').referredByInfluencer, 'SASHA1');
    assert.equal(db._get('users/newUid').referredByInfluencerPlatform, 'yt');
    assert.equal(db._get('referrers/SASHA1').registrations, 1);
    // click also recorded because a chatId was supplied
    assert.equal(db._get('referrers/SASHA1').clicks, 1);
  } finally { teardown(); }
});

test('attributeReferral: consumer code still goes through the original consumer flow', async () => {
  const db = injectMockDb({ 'users/referrer1': { referralCode: 'AbCdEfGh', chatId: 999 } });
  try {
    const { attributeReferral } = require('../partners');
    const r = await attributeReferral('newUid2', 'AbCdEfGh', {});
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'consumer');
    assert.equal(db._get('users/newUid2').referredBy, 'AbCdEfGh');
  } finally { teardown(); }
});

test('attributeReferral: unknown code is reported invalid, nothing written', async () => {
  const db = injectMockDb({});
  try {
    const { attributeReferral } = require('../partners');
    const r = await attributeReferral('newUid3', 'DOESNOTEXIST', {});
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'invalid');
    assert.equal(db._get('users/newUid3'), undefined);
  } finally { teardown(); }
});

test('attributeReferral: re-attributing an already-referred user is a no-op (idempotent)', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER },
    'users/existingUid': { referredByInfluencer: 'SASHA1', referredByInfluencerPlatform: 'tg' },
  });
  try {
    const { attributeReferral } = require('../partners');
    const r = await attributeReferral('existingUid', 'sasha1_yt', {});
    assert.equal(r.ok, false);
    assert.equal(r.alreadyReferred, true);
    // platform must NOT have been overwritten by the second, different-platform click
    assert.equal(db._get('users/existingUid').referredByInfluencerPlatform, 'tg');
    assert.equal(db._get('referrers/SASHA1').registrations, 0); // never incremented past the seeded value
  } finally { teardown(); }
});

// ── Dashboard read model ─────────────────────────────────────────────────────

test('getOrCreateTrackingLink: idempotent, returns a stable URL per platform', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER } });
  try {
    process.env.TELEGRAM_BOT_USERNAME = 'EnmaTestBot';
    const { getOrCreateTrackingLink } = require('../partners');
    const a = await getOrCreateTrackingLink('SASHA1', 'ig');
    const b = await getOrCreateTrackingLink('SASHA1', 'ig');
    assert.equal(a.url, 'https://t.me/EnmaTestBot?start=ref_SASHA1_ig');
    assert.equal(a.url, b.url);
    assert.ok(db._get('referrers/SASHA1/links/ig'));
  } finally { delete process.env.TELEGRAM_BOT_USERNAME; teardown(); }
});

test('getPartnerSummary: aggregates referrer + links + recent earnings', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, clicks: 5, registrations: 2, totalEarned: 300, pendingPayout: 300 },
    'referrers/SASHA1/links/tg': { platform: 'tg', clicks: 5, registrations: 2, payments: 1, commission: 300 },
    'referralEarnings/e1': { referrerId: 'SASHA1', amount: 1000, commission: 300, status: 'pending', platform: 'tg', createdAt: mockAdmin.firestore.FieldValue.serverTimestamp() },
  });
  try {
    const { getPartnerSummary } = require('../partners');
    const summary = await getPartnerSummary('SASHA1');
    assert.equal(summary.clicks, 5);
    assert.equal(summary.registrations, 2);
    assert.equal(summary.payments, 1);
    assert.equal(summary.pendingPayout, 300);
    assert.equal(summary.links.length, 1);
    assert.equal(summary.links[0].url, 'https://t.me/EnmaAI_bot?start=ref_SASHA1_tg');
    assert.equal(summary.recentEarnings.length, 1);
  } finally { teardown(); }
});

test('getPartnerSummary: unknown code returns null', async () => {
  const db = injectMockDb({});
  try {
    const { getPartnerSummary } = require('../partners');
    assert.equal(await getPartnerSummary('NOPE'), null);
  } finally { teardown(); }
});
