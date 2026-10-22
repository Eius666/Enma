// Subscription state table: the subscriptions/{uid} document as each server
// path writes it, and what the server rules (api/_lib/subscription/plan.js)
// and the client display (src/subscription.ts) make of it. Rows where the two
// must agree are asserted as agreement; the remaining differences are product
// decisions and are pinned explicitly as such.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as client from '../../../../src/subscription.ts';

const require = createRequire(import.meta.url);
const server = require('../plan.js');

const NOW = Date.parse('2026-10-22T12:00:00Z');
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

function atNow(fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}
const clientView = (sub) => atNow(() => ({
  plan: client.getActivePlan(sub),
  active: sub ? client.isSubscriptionActive(sub) : false,
  inTrial: sub ? client.isInTrial(sub) : false,
}));
const serverPlan = (sub) => server.resolveActivePlan(sub, NOW);

// ── shapes, as written by each path ─────────────────────────────────────────
const trialDoc = () => server.buildTrialSubscription('u1', { now: new Date(NOW - DAY), trialEnd: new Date(NOW + 6 * DAY) }, 'TS');
// payment/[action].js callback (SBP), balance path and Stars (computeExtension): endDate + endDateMs together
const extendedDoc = (plan, endMs, extra = {}) => ({ userId: 'u1', plan, period: 'month', status: 'active', startDate: iso(NOW - 10 * DAY), endDate: iso(endMs), endDateMs: endMs, lastPaymentMethod: 'sbp', ...extra });
// ton/verify.js and the admin grant / admin extension: expiresAt + endDateMs, no endDate
const expiresDoc = (plan, endMs, extra = {}) => ({ userId: 'u1', plan, status: 'active', expiresAt: ts(endMs), endDateMs: endMs, ...extra });

const ROWS = [
  // name, document, server plan, client plan, client "active"
  ['no document', null, 'free', 'free', false],
  ['trial just granted', trialDoc(), 'premium', 'premium', true],
  ['trial ended', server.buildTrialSubscription('u1', { now: new Date(NOW - 8 * DAY), trialEnd: new Date(NOW - DAY) }, 'TS'), 'free', 'free', false],
  ['SBP / balance / Stars: active Pro', extendedDoc('pro', NOW + 20 * DAY), 'pro', 'pro', true],
  ['SBP / balance / Stars: active Premium', extendedDoc('premium', NOW + 20 * DAY, { lastPaymentMethod: 'stars' }), 'premium', 'premium', true],
  ['SBP / balance / Stars: period over', extendedDoc('pro', NOW - DAY), 'free', 'free', false],
  ['TON payment: no endDate, only expiresAt + endDateMs', expiresDoc('pro', NOW + 30 * DAY, { lastPaymentId: 'p1' }), 'pro', 'pro', true],
  ['admin grant on a new user: no endDate', expiresDoc('premium', NOW + 30 * DAY, { grantedByAdmin: true }), 'premium', 'premium', true],
  ['admin grant on top of an old SBP period: endDate stale, endDateMs new', { ...extendedDoc('pro', NOW - 40 * DAY), ...expiresDoc('pro', NOW + 30 * DAY, { grantedByAdmin: true }) }, 'pro', 'pro', true],
  ['TON / admin period over', expiresDoc('pro', NOW - DAY), 'free', 'free', false],
  ['only expiresAt (no endDateMs)', { userId: 'u1', plan: 'pro', status: 'active', expiresAt: ts(NOW + 5 * DAY) }, 'pro', 'pro', true],
  ['Stars refund rolled back to the previous end', extendedDoc('pro', NOW + 3 * DAY, { lastPaymentMethod: 'stars' }), 'pro', 'pro', true],
  ['Stars refund of the first payment: status expired', { ...extendedDoc('pro', NOW + 25 * DAY), status: 'expired' }, 'free', 'free', false],
  ['admin cancel of a paid plan', { ...extendedDoc('premium', NOW + 25 * DAY), status: 'cancelled' }, 'free', 'free', false],
  ['endDate in the future but endDateMs past (server reads endDateMs)', { ...extendedDoc('pro', NOW - DAY), endDate: iso(NOW + 9 * DAY) }, 'free', 'free', false],
];

for (const [name, doc, serverExpected, clientExpected, clientActive] of ROWS) {
  test(`state: ${name}`, () => {
    assert.equal(serverPlan(doc), serverExpected, 'server plan');
    const view = clientView(doc);
    assert.equal(view.plan, clientExpected, 'client plan');
    assert.equal(view.active, clientActive, 'client active');
    assert.equal(view.plan, serverPlan(doc), 'client shows what the server grants');
  });
}

test('client end date of the paid period follows the server precedence (endDateMs, expiresAt, endDate)', () => {
  assert.equal(client.getSubscriptionEndMs(expiresDoc('pro', NOW + 5 * DAY)), NOW + 5 * DAY);
  assert.equal(client.getSubscriptionEndMs({ ...extendedDoc('pro', NOW - 40 * DAY), endDateMs: NOW + 7 * DAY }), NOW + 7 * DAY);
  assert.equal(client.getSubscriptionEndMs({ plan: 'pro', status: 'active', expiresAt: ts(NOW + DAY) }), NOW + DAY);
  assert.equal(client.getSubscriptionEndMs({ plan: 'pro', status: 'active', endDate: iso(NOW + 2 * DAY) }), NOW + 2 * DAY);
  assert.ok(Number.isNaN(client.getSubscriptionEndMs({ plan: 'pro', status: 'active' })));
});

test('days remaining use the same end date', () => {
  assert.equal(atNow(() => client.getDaysRemaining(expiresDoc('pro', NOW + 5 * DAY))), 5);
  assert.equal(atNow(() => client.getDaysRemaining(trialDoc())), 6);
});

// ── remaining differences: product decisions, not display bugs ─────────────
test('OWNER DECISION: paid plan bought during a running trial — server grants the paid plan, client shows the trial plan until the trial ends', () => {
  const doc = { ...trialDoc(), ...extendedDoc('pro', NOW + 30 * DAY) };
  assert.equal(serverPlan(doc), 'pro');
  assert.equal(clientView(doc).plan, 'premium');
});

test('OWNER DECISION: cancelled document with a running trial date — server free, client still shows the trial', () => {
  const doc = { ...trialDoc(), status: 'cancelled' };
  assert.equal(serverPlan(doc), 'free');
  assert.equal(clientView(doc).plan, 'premium');
});

test('OWNER DECISION: active document without any end date — server grants the plan indefinitely, client shows free', () => {
  const doc = { userId: 'u1', plan: 'pro', status: 'active' };
  assert.equal(serverPlan(doc), 'pro');
  assert.equal(clientView(doc).plan, 'free');
});
