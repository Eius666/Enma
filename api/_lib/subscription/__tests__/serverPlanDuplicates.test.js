'use strict';

// Other server code that decides "which plan does this subscription give"
// on its own instead of calling resolveActivePlan (api/_lib/subscription/
// plan.js): the admin user list, the admin dashboard and the Telegram bot's
// AI gate (api/_lib/ai/subscription.js). Same documents through all of them.
// Agreement is asserted; today's differences are pinned so that unifying
// them later is a visible, deliberate change.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../../evals/fixtures');
const { resolveActivePlan } = require('../plan');
const { createUsersHandlers } = require('../../admin/usersHandlers');
const { createStatsHandlers } = require('../../admin/statsHandlers');

const DAY = 86400000;
const { Timestamp } = mockAdmin.firestore;
const iso = (ms) => new Date(ms).toISOString();
const now = () => Date.now();

const DOCS = {
  paidWithBothDates: () => ({ plan: 'pro', status: 'active', endDate: iso(now() + 9 * DAY), endDateMs: now() + 9 * DAY }),
  paidExpired: () => ({ plan: 'pro', status: 'active', endDate: iso(now() - DAY), endDateMs: now() - DAY }),
  tonNoEndDate: () => ({ plan: 'premium', status: 'active', expiresAt: Timestamp.fromMillis(now() + 9 * DAY), endDateMs: now() + 9 * DAY }),
  expiresAtOnly: () => ({ plan: 'pro', status: 'active', expiresAt: Timestamp.fromMillis(now() + 9 * DAY) }),
  expiresAtOnlyExpired: () => ({ plan: 'pro', status: 'active', expiresAt: Timestamp.fromMillis(now() - DAY) }),
  trialRunning: () => ({ plan: 'free', trialPlan: 'premium', status: 'active', endDate: iso(now() + 5 * DAY), endDateMs: now() + 5 * DAY, trialEndDate: iso(now() + 5 * DAY) }),
  cancelled: () => ({ plan: 'pro', status: 'cancelled', endDate: iso(now() + 9 * DAY), endDateMs: now() + 9 * DAY }),
};

const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

async function adminListPlan(doc) {
  const db = createMockDb({ 'users/u1': { createdAt: Timestamp.fromMillis(now() - DAY) }, 'subscriptions/u1': doc });
  const { handleAdminUsers } = createUsersHandlers({ db, admin: mockAdmin, requireAdmin: () => true });
  const r = res();
  await quiet(() => handleAdminUsers({ body: {} }, r));
  return r.body.users[0].plan;
}

async function adminDashboardPlan(doc) {
  const db = createMockDb({ 'users/u1': { createdAt: Timestamp.fromMillis(now() - DAY) }, 'subscriptions/u1': doc });
  const { handleAdminStats } = createStatsHandlers({ db, requireAdmin: () => true });
  const r = res();
  await quiet(() => handleAdminStats({ body: {} }, r));
  const d = r.body.planDist;
  return d.premium ? 'premium' : d.pro ? 'pro' : 'free';
}

const AI_SUB = require.resolve('../../ai/subscription');
const FA = require.resolve('../../firebaseAdmin');
async function botAiGate(doc) {
  const db = createMockDb({ 'subscriptions/u1': { userId: 'u1', ...doc } });
  require.cache[FA] = { id: FA, filename: FA, loaded: true, exports: { db, admin: mockAdmin } };
  delete require.cache[AI_SUB];
  const { checkSubscription } = require(AI_SUB);
  const out = await checkSubscription('u1');
  return out.active ? out.plan : 'free';
}
after(() => { delete require.cache[AI_SUB]; delete require.cache[FA]; });

// [doc, rules (resolveActivePlan), admin user list, admin dashboard, bot AI gate]
const TABLE = [
  ['paidWithBothDates', 'pro', 'pro', 'pro', 'pro'],
  ['paidExpired', 'free', 'free', 'free', 'free'],
  ['tonNoEndDate', 'premium', 'premium', 'premium', 'free'],
  ['expiresAtOnly', 'pro', 'pro', 'pro', 'free'],
  ['expiresAtOnlyExpired', 'free', 'pro', 'free', 'free'],
  ['trialRunning', 'premium', 'free', 'free', 'free'],
  ['cancelled', 'free', 'free', 'free', 'free'],
];

for (const [name, rules, list, dashboard, bot] of TABLE) {
  test(`plan of "${name}": rules=${rules}, admin list=${list}, admin dashboard=${dashboard}, bot AI gate=${bot}`, async () => {
    const doc = DOCS[name]();
    assert.equal(resolveActivePlan(doc), rules, 'resolveActivePlan');
    assert.equal(await adminListPlan(doc), list, 'admin user list');
    assert.equal(await adminDashboardPlan(doc), dashboard, 'admin dashboard');
    assert.equal(await botAiGate(doc), bot, 'bot AI gate');
  });
}

test('PINNED: the bot AI gate reads only endDate, so TON and admin-granted plans without endDate get no AI access in the bot', async () => {
  assert.equal(resolveActivePlan(DOCS.tonNoEndDate()), 'premium');
  assert.equal(await botAiGate(DOCS.tonNoEndDate()), 'free');
});

test('PINNED: the bot AI gate counts a running trial as active with plan "free" (the trial plan is not consulted)', async () => {
  const db = createMockDb({ 'subscriptions/u1': { userId: 'u1', ...DOCS.trialRunning() } });
  require.cache[FA] = { id: FA, filename: FA, loaded: true, exports: { db, admin: mockAdmin } };
  delete require.cache[AI_SUB];
  assert.deepEqual(await require(AI_SUB).checkSubscription('u1'), { active: true, plan: 'free' });
});
