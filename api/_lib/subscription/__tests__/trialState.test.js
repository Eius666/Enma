'use strict';

// readTrialState (the prepared reader for the split of users.trialUsed) must
// make exactly the decisions the live code makes today, for every legacy and
// target document shape: the payment trial grant (POST /api/payment/trial) and
// the Telegram bot's free AI request counter (ai/subscription.js getTrialUsed).

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../evals/fixtures');
const { readTrialState } = require('../trialState');

const FA = require.resolve('../../firebaseAdmin');
const PAYMENT_MODULES = [
  '../../../payment/[action]', '../../auth/paymentAuth', '../../referral/influencer', '../../referral/partners',
  '../../referral/codes', '../../promoCodes', '../../platega', '../../subscription/extend', '../../stars/config', '../../stars/sessions',
  '../../ai/subscription',
];
const JWT = 'aaaa.bbbb.cccc';

function load(seed) {
  const db = createMockDb(seed);
  const admin = { ...mockAdmin, auth: () => ({ verifyIdToken: async () => ({ uid: 'u1' }) }) };
  require.cache[FA] = { id: FA, filename: FA, loaded: true, exports: { db, admin } };
  for (const p of PAYMENT_MODULES) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
afterEach(() => {
  delete require.cache[FA];
  for (const p of PAYMENT_MODULES) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
});

async function liveTrialDecision(user, subscription) {
  const seed = {};
  if (user) seed['users/u1'] = user;
  if (subscription) seed['subscriptions/u1'] = subscription;
  load(seed);
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() {} };
  const quiet = ['log', 'error', 'warn'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  try {
    await require('../../../payment/[action]')({ method: 'POST', query: { action: 'trial' }, body: { userId: 'u1' }, headers: { authorization: `Bearer ${JWT}` } }, res);
  } finally { for (const [k, f] of quiet) console[k] = f; }
  if (res.statusCode === 200) return null;
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  return res.body.code;
}

async function liveAiCounter(user) {
  load(user ? { 'users/u1': user } : {});
  return require('../../ai/subscription').getTrialUsed('u1');
}

const USERS = [
  ['no profile document', undefined],
  ['new profile', {}],
  ['legacy: trial granted (true)', { trialUsed: true }],
  ['legacy: false', { trialUsed: false }],
  ['legacy: AI counter 3', { trialUsed: 3 }],
  ['legacy: numeric value 1', { trialUsed: 1 }],
  ['legacy: fractional counter', { trialUsed: 2.7 }],
  ['legacy: zero / negative counter', { trialUsed: 0 }],
  ['legacy: string value', { trialUsed: 'yes' }],
  ['target: trial started, no AI use', { subscriptionTrialStartedAt: '2026-10-01T00:00:00.000Z' }],
  ['target: AI counter only', { aiTrialRequestsUsed: 4 }],
  ['target + legacy together', { trialUsed: 2, subscriptionTrialStartedAt: '2026-10-01T00:00:00.000Z', aiTrialRequestsUsed: 5 }],
];
const SUBSCRIPTIONS = [
  ['no subscription', undefined],
  ['trial subscription', { userId: 'u1', plan: 'free', trialPlan: 'premium', status: 'active', paymentMethod: 'trial', endDateMs: 4102444800000 }],
  ['paid subscription', { userId: 'u1', plan: 'pro', status: 'active', lastPaymentMethod: 'sbp', endDateMs: 4102444800000 }],
  ['expired paid subscription', { userId: 'u1', plan: 'pro', status: 'active', lastPaymentMethod: 'sbp', endDateMs: 1577836800000 }],
];

for (const [userName, user] of USERS) {
  for (const [subName, sub] of SUBSCRIPTIONS) {
    // Target fields are not written by any live code yet, so the live handler
    // cannot be expected to know them: compare legacy shapes only.
    const legacyOnly = !user || !('subscriptionTrialStartedAt' in user || 'aiTrialRequestsUsed' in user);
    if (!legacyOnly) continue;
    test(`trial grant decision matches the live handler: ${userName} / ${subName}`, async () => {
      const live = await liveTrialDecision(user, sub);
      const read = readTrialState(user, sub);
      assert.equal(read.refusal, live);
      assert.equal(read.trialGrantAllowed, live === null);
    });
  }
  if (!user || !('aiTrialRequestsUsed' in user)) {
    test(`AI trial counter matches the live bot gate: ${userName}`, async () => {
      assert.equal(readTrialState(user, undefined).aiTrialRequestsUsed, await liveAiCounter(user));
    });
  }
}

test('target fields: the trial marker survives an AI counter, and the counter is read from its own field', () => {
  assert.deepEqual(readTrialState({ trialUsed: 2, subscriptionTrialStartedAt: '2026-10-01T00:00:00.000Z', aiTrialRequestsUsed: 5 }, undefined),
    { trialGrantAllowed: false, refusal: 'TRIAL_USED', aiTrialRequestsUsed: 5 });
  assert.deepEqual(readTrialState({ aiTrialRequestsUsed: 4 }, undefined), { trialGrantAllowed: true, refusal: null, aiTrialRequestsUsed: 4 });
});

test('with a numeric trialUsed, the subscription document decides the trial grant', () => {
  assert.equal(readTrialState({ trialUsed: 1 }, undefined).trialGrantAllowed, true);
  assert.equal(readTrialState({ trialUsed: 1 }, SUBSCRIPTIONS[1][1]).trialGrantAllowed, false);
});
