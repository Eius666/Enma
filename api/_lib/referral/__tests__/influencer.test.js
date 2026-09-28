'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');

const MODULE_PATHS = ['../influencer', '../partners', '../codes'];

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
  code: 'SASHA1', name: 'Sasha', status: 'active',
  commissionPercent: 30, discountPercent: 10,
  clicks: 0, registrations: 0, totalEarned: 0, pendingPayout: 0, paidOut: 0,
};

// ── validateInfluencerCode ───────────────────────────────────────────────────

test('validateInfluencerCode: valid/active code returns its rates', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER } });
  try {
    const { validateInfluencerCode } = require('../influencer');
    const r = await validateInfluencerCode('sasha1');
    assert.equal(r.valid, true);
    assert.equal(r.code, 'SASHA1');
    assert.equal(r.commissionPercent, 30);
    assert.equal(r.discountPercent, 10);
  } finally { teardown(); }
});

test('validateInfluencerCode: unknown / inactive code is rejected', async () => {
  const db = injectMockDb({ 'referrers/DEAD1': { ...PARTNER, code: 'DEAD1', status: 'inactive' } });
  try {
    const { validateInfluencerCode } = require('../influencer');
    assert.equal((await validateInfluencerCode('nope')).valid, false);
    assert.equal((await validateInfluencerCode('dead1')).error, 'referral_inactive');
  } finally { teardown(); }
});

test('validateInfluencerCode: user already referred by a DIFFERENT partner is blocked', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER },
    'users/u1': { referredByInfluencer: 'OTHER1' },
  });
  try {
    const { validateInfluencerCode } = require('../influencer');
    const r = await validateInfluencerCode('sasha1', 'u1');
    assert.equal(r.valid, false);
    assert.equal(r.error, 'already_referred');
  } finally { teardown(); }
});

// ── recordInfluencerReferral ─────────────────────────────────────────────────

test('recordInfluencerReferral: first call attributes + bumps registrations (referrer and per-link)', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER } });
  try {
    const { recordInfluencerReferral } = require('../influencer');
    const wrote = await recordInfluencerReferral('u1', 'sasha1', 'tg');
    assert.equal(wrote, true);
    assert.equal(db._get('users/u1').referredByInfluencer, 'SASHA1');
    assert.equal(db._get('users/u1').referredByInfluencerPlatform, 'tg');
    assert.equal(db._get('referrers/SASHA1').registrations, 1);
    assert.equal(db._get('referrers/SASHA1/links/tg').registrations, 1);
    // fields present before this call must survive (merge, not overwrite)
    assert.equal(db._get('referrers/SASHA1').name, 'Sasha');
    assert.equal(db._get('referrers/SASHA1').commissionPercent, 30);
  } finally { teardown(); }
});

test('recordInfluencerReferral: second call for the same user is a no-op', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, registrations: 1 },
    'users/u1': { referredByInfluencer: 'SASHA1', referredByInfluencerPlatform: 'tg' },
  });
  try {
    const { recordInfluencerReferral } = require('../influencer');
    const wrote = await recordInfluencerReferral('u1', 'sasha1', 'yt');
    assert.equal(wrote, false);
    assert.equal(db._get('referrers/SASHA1').registrations, 1); // unchanged
    assert.equal(db._get('users/u1').referredByInfluencerPlatform, 'tg'); // unchanged
  } finally { teardown(); }
});

// ── processInfluencerCommission ──────────────────────────────────────────────

test('processInfluencerCommission: 30% of the paid amount, stamped with the platform, merges into referrer totals', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER },
    'users/payer1': { telegramId: 111, referredByInfluencerPlatform: 'tg' },
  });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r.commission, 300);
    assert.equal(db._get('referrers/SASHA1').totalEarned, 300);
    assert.equal(db._get('referrers/SASHA1').pendingPayout, 300);
    const earning = db._get(`referralEarnings/${r.earnId}`);
    assert.equal(earning.platform, 'tg');
    assert.equal(earning.status, 'pending');
    assert.equal(earning.subscriptionId, 'sub_1');
    // fields set before this call must survive the merge
    assert.equal(db._get('referrers/SASHA1').name, 'Sasha');
  } finally { teardown(); }
});

test('processInfluencerCommission: uses a custom commissionPercent when set', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER, commissionPercent: 50 } });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r.commission, 500);
  } finally { teardown(); }
});

test('processInfluencerCommission: inactive partner earns nothing', async () => {
  const db = injectMockDb({ 'referrers/SASHA1': { ...PARTNER, status: 'inactive' } });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r, null);
  } finally { teardown(); }
});

test('processInfluencerCommission: unknown code is a safe no-op, never throws', async () => {
  const db = injectMockDb({});
  try {
    const { processInfluencerCommission } = require('../influencer');
    assert.equal(await processInfluencerCommission('payer1', 'nope', 1000, 'sub_1'), null);
    assert.equal(await processInfluencerCommission('payer1', null, 1000, 'sub_1'), null);
  } finally { teardown(); }
});

// ── Self-referral guard ──────────────────────────────────────────────────────

test('SECURITY: a partner cannot earn commission on their own payment', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, telegramId: 555 },
    'users/payer1': { telegramId: 555 }, // same Telegram identity as the partner
  });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r, null);
    assert.equal(db._get('referrers/SASHA1').totalEarned, 0);
  } finally { teardown(); }
});

test('a DIFFERENT Telegram identity still earns commission normally', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, telegramId: 555 },
    'users/payer1': { telegramId: 999 },
  });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r.commission, 300);
  } finally { teardown(); }
});

test('admin-created partner with no linked Telegram identity is never blocked as self-referral', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER }, // no telegramId field at all
    'users/payer1': { telegramId: 555 },
  });
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_1');
    assert.equal(r.commission, 300);
  } finally { teardown(); }
});

// ── Anti-fraud: daily anomaly threshold ──────────────────────────────────────

test('ANTI-FRAUD: the 20th+ conversion in one day is blocked and does not pay out', async () => {
  const seed = { 'referrers/SASHA1': { ...PARTNER } };
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    seed[`referralEarnings/e${i}`] = {
      referrerId: 'SASHA1', createdAt: { toMillis: () => now.getTime(), toDate: () => now },
    };
  }
  const db = injectMockDb(seed);
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_new');
    assert.equal(r, null, 'the 21st same-day conversion must be blocked');
    assert.equal(db._get('referrers/SASHA1').totalEarned, 0);
  } finally { teardown(); }
});

test('under the threshold, commission still pays out normally', async () => {
  const seed = { 'referrers/SASHA1': { ...PARTNER } };
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    seed[`referralEarnings/e${i}`] = {
      referrerId: 'SASHA1', createdAt: { toMillis: () => now.getTime(), toDate: () => now },
    };
  }
  const db = injectMockDb(seed);
  try {
    const { processInfluencerCommission } = require('../influencer');
    const r = await processInfluencerCommission('payer1', 'sasha1', 1000, 'sub_new');
    assert.equal(r.commission, 300);
  } finally { teardown(); }
});

// ── Cancellation clawback ────────────────────────────────────────────────────

test('cancelInfluencerCommission: within the 7-day window, claws back the commission', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, totalEarned: 300, pendingPayout: 300 },
    'referrers/SASHA1/links/tg': { platform: 'tg', commission: 300 },
    'referralEarnings/e1': {
      referrerId: 'SASHA1', userId: 'payer1', subscriptionId: 'sub_1',
      commission: 300, platform: 'tg', status: 'pending',
      createdAt: { toMillis: () => Date.now(), toDate: () => new Date() },
    },
  });
  try {
    const { cancelInfluencerCommission } = require('../influencer');
    const r = await cancelInfluencerCommission('payer1', 'sub_1');
    assert.equal(r.withinWindow, true);
    assert.equal(r.clawedBack, 300);
    assert.equal(db._get('referralEarnings/e1').status, 'cancelled');
    assert.equal(db._get('referrers/SASHA1').pendingPayout, 0);
    assert.equal(db._get('referrers/SASHA1/links/tg').commission, 0);
    // totalEarned is a lifetime figure — cancellation only reverses pendingPayout
    assert.equal(db._get('referrers/SASHA1').totalEarned, 300);
  } finally { teardown(); }
});

test('cancelInfluencerCommission: outside the 7-day window, the partner keeps the commission', async () => {
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, totalEarned: 300, pendingPayout: 300 },
    'referralEarnings/e1': {
      referrerId: 'SASHA1', userId: 'payer1', subscriptionId: 'sub_1',
      commission: 300, platform: 'tg', status: 'pending',
      createdAt: { toMillis: () => eightDaysAgo, toDate: () => new Date(eightDaysAgo) },
    },
  });
  try {
    const { cancelInfluencerCommission } = require('../influencer');
    const r = await cancelInfluencerCommission('payer1', 'sub_1');
    assert.equal(r.withinWindow, false);
    assert.equal(db._get('referralEarnings/e1').status, 'pending'); // untouched
    assert.equal(db._get('referrers/SASHA1').pendingPayout, 300);   // untouched
  } finally { teardown(); }
});

test('cancelInfluencerCommission: no matching earning is a safe no-op', async () => {
  const db = injectMockDb({});
  try {
    const { cancelInfluencerCommission } = require('../influencer');
    assert.equal(await cancelInfluencerCommission('payer1', 'sub_missing'), null);
  } finally { teardown(); }
});

test('cancelInfluencerCommission: an already-cancelled earning is not double-reversed', async () => {
  const db = injectMockDb({
    'referrers/SASHA1': { ...PARTNER, pendingPayout: 0 },
    'referralEarnings/e1': {
      referrerId: 'SASHA1', userId: 'payer1', subscriptionId: 'sub_1',
      commission: 300, status: 'cancelled', // already handled once
      createdAt: { toMillis: () => Date.now(), toDate: () => new Date() },
    },
  });
  try {
    const { cancelInfluencerCommission } = require('../influencer');
    const r = await cancelInfluencerCommission('payer1', 'sub_1');
    assert.equal(r, null); // query only matches status=='pending'
    assert.equal(db._get('referrers/SASHA1').pendingPayout, 0);
  } finally { teardown(); }
});
