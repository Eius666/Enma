'use strict';

// Covers the cross-rail subscription-extension rule introduced to fix the
// "Stars purchase after an active SBP subscription resets endDate instead of
// extending it" bug found in the Telegram Stars Audit (§10/§27): paying
// through ANY rail must extend from max(now, currentEndDate), never from
// `now` alone.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockDb, mockAdmin } = require('../../evals/fixtures');

const MODULE_PATHS = ['../extend'];

function injectMockDb(seed) {
  const db = createMockDb(seed);
  const fa = require.resolve('../../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../../firebaseAdmin')]; } catch (_) {}
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

const DAY_MS = 24 * 60 * 60 * 1000;

test('computeExtension: no existing subscription extends from now', () => {
  const db = injectMockDb({});
  try {
    const { computeExtension } = require('../extend');
    const before = Date.now();
    const ext = computeExtension(null, 30);
    assert.ok(ext.baseMs >= before);
    assert.equal(ext.previousEndMs, null);
    assert.ok(Math.abs(ext.newEndMs - (ext.baseMs + 30 * DAY_MS)) < 1000);
  } finally { teardown(); }
});

test('computeExtension: active subscription extends from its endDate, not from now', () => {
  const db = injectMockDb({});
  try {
    const { computeExtension } = require('../extend');
    const futureEndMs = Date.now() + 15 * DAY_MS;
    const ext = computeExtension({ endDateMs: futureEndMs }, 30);
    assert.equal(ext.baseMs, futureEndMs);
    assert.equal(ext.newEndMs, futureEndMs + 30 * DAY_MS);
  } finally { teardown(); }
});

test('computeExtension: EXPIRED subscription extends from now, not from the stale past endDate', () => {
  const db = injectMockDb({});
  try {
    const { computeExtension } = require('../extend');
    const pastEndMs = Date.now() - 10 * DAY_MS;
    const before = Date.now();
    const ext = computeExtension({ endDateMs: pastEndMs }, 30);
    assert.ok(ext.baseMs >= before);
    assert.notEqual(ext.baseMs, pastEndMs);
  } finally { teardown(); }
});

test('extendSubscription: SBP (30d) then Stars (30d) accumulates to ~60 days, never resets', async () => {
  const db = injectMockDb({});
  try {
    const { extendSubscription } = require('../extend');

    const first = await extendSubscription('u1', { plan: 'pro', periodDays: 30, paymentMethod: 'sbp' });
    const sub1  = db._get('subscriptions/u1');
    assert.equal(sub1.endDateMs, first.newEndMs);

    const second = await extendSubscription('u1', { plan: 'pro', periodDays: 30, paymentMethod: 'stars' });
    assert.equal(second.baseMs, first.newEndMs, 'second extension must start from the first one\'s endDate');
    assert.equal(second.newEndMs, first.newEndMs + 30 * DAY_MS);

    const sub2 = db._get('subscriptions/u1');
    assert.equal(sub2.endDateMs, second.newEndMs);
    assert.equal(sub2.lastPaymentMethod, 'stars');
  } finally { teardown(); }
});

test('extendSubscription: preserves plan/startDate across merges when not overridden', async () => {
  const db = injectMockDb({
    'subscriptions/u1': { plan: 'premium', startDate: '2020-01-01T00:00:00.000Z', endDateMs: Date.now() + 5 * DAY_MS },
  });
  try {
    const { extendSubscription } = require('../extend');
    await extendSubscription('u1', { periodDays: 30, paymentMethod: 'stars' });
    const sub = db._get('subscriptions/u1');
    assert.equal(sub.plan, 'premium');
    assert.equal(sub.startDate, '2020-01-01T00:00:00.000Z');
  } finally { teardown(); }
});
