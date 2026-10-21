'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveActivePlan, computeTrialWindow, buildTrialSubscription, TRIAL_DAYS } = require('../plan');

const NOW = Date.parse('2026-10-21T12:00:00Z');

test('resolveActivePlan: boundaries', () => {
  assert.equal(resolveActivePlan(null, NOW), 'free');
  assert.equal(resolveActivePlan(undefined, NOW), 'free');
  assert.equal(resolveActivePlan({ status: 'expired', plan: 'pro', endDateMs: NOW + 1e9 }, NOW), 'free');
  assert.equal(resolveActivePlan({ status: 'active', plan: 'pro', endDateMs: NOW + 1 }, NOW), 'pro');
  assert.equal(resolveActivePlan({ status: 'active', plan: 'pro', endDateMs: NOW - 1 }, NOW), 'free');
  assert.equal(resolveActivePlan({ status: 'active', plan: 'premium' }, NOW), 'premium', 'no end date recorded: stored plan applies');
  assert.equal(resolveActivePlan({ status: 'active' }, NOW), 'free', 'no plan: free');
});

test('resolveActivePlan: legacy Firestore Timestamp expiresAt is honoured', () => {
  assert.equal(resolveActivePlan({ status: 'active', plan: 'pro', expiresAt: { toMillis: () => NOW - 5 } }, NOW), 'free');
  assert.equal(resolveActivePlan({ status: 'active', plan: 'pro', expiresAt: { toMillis: () => NOW + 5 } }, NOW), 'pro');
});

test('resolveActivePlan: a running trial grants the trial plan; an ended trial does not', () => {
  const base = { status: 'active', plan: 'free', trialPlan: 'premium', endDateMs: NOW + 1 };
  assert.equal(resolveActivePlan({ ...base, trialEndDate: new Date(NOW + 1000).toISOString() }, NOW), 'premium');
  assert.equal(resolveActivePlan({ ...base, endDateMs: NOW - 1, trialEndDate: new Date(NOW - 1000).toISOString() }, NOW), 'free');
});

test('trial window: 7 days ahead, end of that day; document shape is exactly the legacy one', () => {
  assert.equal(TRIAL_DAYS, 7);
  const win = computeTrialWindow(new Date('2026-10-21T08:15:00'));
  assert.equal(win.trialEnd.getDate(), 28);
  assert.equal([win.trialEnd.getHours(), win.trialEnd.getMinutes(), win.trialEnd.getSeconds(), win.trialEnd.getMilliseconds()].join(':'), '23:59:59:999');
  const marker = { _fv: 'serverTimestamp' };
  const doc = buildTrialSubscription('u1', win, marker);
  assert.deepEqual(Object.keys(doc).sort(), [
    'createdAt', 'endDate', 'endDateMs', 'id', 'paymentMethod', 'period', 'plan', 'startDate',
    'status', 'trialEndDate', 'trialEndDateMs', 'trialPlan', 'updatedAt', 'userId',
  ]);
  assert.deepEqual(
    { id: doc.id, userId: doc.userId, plan: doc.plan, trialPlan: doc.trialPlan, period: doc.period, status: doc.status, paymentMethod: doc.paymentMethod },
    { id: 'trial_u1', userId: 'u1', plan: 'free', trialPlan: 'premium', period: 'month', status: 'active', paymentMethod: 'trial' }
  );
  assert.equal(doc.endDateMs, win.trialEnd.getTime());
  assert.equal(doc.trialEndDateMs, doc.endDateMs);
  assert.equal(doc.endDate, doc.trialEndDate);
  assert.equal(doc.updatedAt, marker);
  // A running trial resolves to its plan through the same rules.
  assert.equal(resolveActivePlan(doc, win.now.getTime()), 'premium');
});
