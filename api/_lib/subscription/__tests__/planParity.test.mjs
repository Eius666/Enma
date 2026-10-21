// Server rules (api/_lib/subscription/plan.js) vs the client's display copy
// (src/subscription.ts). Same inputs through both; identical results are
// asserted, and the places where they DIFFER today are pinned explicitly so a
// change on either side is a conscious decision, not silent drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as client from '../../../../src/subscription.ts';

const require = createRequire(import.meta.url);
const server = require('../plan.js');

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();
const clientPlanAt = (sub) => {
  const real = Date.now;
  Date.now = () => NOW;
  const RealDate = Date;
  // Client code uses `new Date()` without arguments: freeze it as well.
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
  try { return client.getActivePlan(sub); } finally { globalThis.Date = RealDate; Date.now = real; }
};
const serverPlanAt = (sub) => server.resolveActivePlan(sub, NOW);

const paid = (plan, daysLeft, extra = {}) => ({
  plan, status: 'active', period: 'month', endDate: iso(daysLeft), endDateMs: NOW + daysLeft * 86400000, ...extra,
});
const trial = (daysLeft, extra = {}) => ({
  plan: 'free', trialPlan: 'premium', status: 'active', period: 'month',
  endDate: iso(daysLeft), endDateMs: NOW + daysLeft * 86400000,
  trialEndDate: iso(daysLeft), trialEndDateMs: NOW + daysLeft * 86400000, paymentMethod: 'trial', ...extra,
});

// ── Agreement ───────────────────────────────────────────────────────────────
const AGREE = [
  ['no subscription', null, 'free'],
  ['active Pro', paid('pro', 10), 'pro'],
  ['active Premium', paid('premium', 10), 'premium'],
  ['expired Pro', paid('pro', -1), 'free'],
  ['expired Premium', paid('premium', -30), 'free'],
  ['running trial', trial(3), 'premium'],
  ['expired trial', trial(-1), 'free'],
  ['trial with trialPlan pro', trial(3, { trialPlan: 'pro' }), 'pro'],
  ['status expired', paid('pro', 10, { status: 'expired' }), 'free'],
];
for (const [name, sub, expected] of AGREE) {
  test(`both agree: ${name} -> ${expected}`, () => {
    assert.equal(serverPlanAt(sub), expected, 'server');
    assert.equal(clientPlanAt(sub), expected, 'client');
  });
}

// ── Known differences (pinned) ──────────────────────────────────────────────
test('KNOWN DIFFERENCE: a paid plan bought while a trial is still running — the client keeps showing the trial plan, the server grants the paid plan', () => {
  const sub = paid('pro', 20, { trialPlan: 'premium', trialEndDate: iso(3), trialEndDateMs: NOW + 3 * 86400000 });
  assert.equal(serverPlanAt(sub), 'pro');
  assert.equal(clientPlanAt(sub), 'premium');
});

test('KNOWN DIFFERENCE: a cancelled/expired-status document with a running trial date — the client still shows the trial plan, the server says free', () => {
  const sub = trial(3, { status: 'cancelled' });
  assert.equal(serverPlanAt(sub), 'free');
  assert.equal(clientPlanAt(sub), 'premium');
});

test('KNOWN DIFFERENCE: trial without an explicit trialPlan — the client defaults to premium, the server requires trialPlan and otherwise falls through to the stored plan', () => {
  const sub = trial(3, { trialPlan: undefined });
  assert.equal(clientPlanAt(sub), 'premium');
  assert.equal(serverPlanAt(sub), 'free');
});

// ── Constants ───────────────────────────────────────────────────────────────
test('AI limits are identical on both sides', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(client.AI_LIMITS)), server.AI_LIMITS);
});

test('trial length is identical (7 days)', () => {
  assert.equal(client.TRIAL_DAYS, 7);
  assert.equal(server.TRIAL_DAYS, 7);
});

test('the free-tier limits the server enforces match the client display (tasks/day, habits, notes)', () => {
  // createEntity.js needs Firebase credentials to load, so read its limit table as text.
  const source = readFileSync(new URL('../../entities/createEntity.js', import.meta.url), 'utf8');
  const limitOf = (type) => Number(new RegExp(`${type}:\\s*\\{[^}]*limit:\\s*(\\d+)`).exec(source)?.[1]);
  assert.equal(limitOf('task'), client.FREE_LIMITS.dailyTasks);
  assert.equal(limitOf('habit'), client.FREE_LIMITS.habits);
  assert.equal(limitOf('note'), client.FREE_LIMITS.notes);
});
