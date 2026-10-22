'use strict';

// Public HTTP surface of the API: which Vercel Functions exist, how they are
// configured, and which route actions each router answers. External callers
// (the Mini App, the admin panel, partners.html, the Telegram webhook and
// external schedulers) depend on all of this, so any change to it has to be a
// deliberate edit of this file, never a side effect of a refactor.
//
// No network, no Firebase: routers run against an in-memory Firestore.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMockDb, mockAdmin } = require('../_lib/evals/fixtures');

const ROOT = path.join(__dirname, '..', '..');
const SAVED_ENV = { ...process.env };
const realFetch = global.fetch;

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  global.fetch = realFetch;
});

// ── Functions and platform configuration ────────────────────────────────────

const FUNCTION_FILES = [
  'api/ai/[action].js',
  'api/auth/telegram.js',
  'api/cron/[job].js',
  'api/insights/[action].js',
  'api/payment/[action].js',
  'api/telegram/cron.js',
  'api/telegram/send.js',
  'api/telegram/webhook.js',
  'api/ton/verify.js',
];

function trackedFiles(prefix) {
  return execFileSync('git', ['ls-files', prefix], { cwd: ROOT }).toString().split('\n').filter(Boolean);
}

test('the set of deployed Vercel Functions is exactly the expected one (Hobby plan: at most 12)', () => {
  // Vercel deploys every api/**/*.js that is not under a path segment starting
  // with "_" (and not a test) as its own Function.
  const deployed = trackedFiles('api')
    .filter(f => f.endsWith('.js'))
    .filter(f => !f.split('/').some(seg => seg.startsWith('_')))
    .sort();
  assert.deepEqual(deployed, [...FUNCTION_FILES].sort());
  assert.ok(deployed.length <= 12);
});

test('vercel.json: function limits, SPA rewrite and cache headers are unchanged', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.deepEqual(cfg.functions, {
    'api/telegram/webhook.js':  { maxDuration: 30 },
    'api/telegram/cron.js':     { maxDuration: 30 },
    'api/cron/[job].js':        { maxDuration: 30 },
    'api/ai/[action].js':       { maxDuration: 30 },
    'api/insights/[action].js': { maxDuration: 15 },
    'api/payment/[action].js':  { maxDuration: 30 },
  });
  for (const f of Object.keys(cfg.functions)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  assert.deepEqual(cfg.rewrites, [{ source: '/((?!api/).*)', destination: '/index.html' }]);
  assert.equal(cfg.crons, undefined, 'no Vercel-managed schedules: reminders are triggered externally');
});

test('edge middleware still guards only /admin paths', () => {
  const src = fs.readFileSync(path.join(ROOT, 'middleware.ts'), 'utf8');
  assert.match(src, /matcher:\s*\['\/admin',\s*'\/admin\/:path\*'\]/);
});

// ── Router action sets ──────────────────────────────────────────────────────

const AI_ACTIONS = {
  // Firebase ID token required → 401 { error: 'Unauthorized' } without one.
  user: ['entityCreate', 'transactionUpdate', 'exportFinancePdf', 'goalCreate', 'goalAdjust', 'goalDelete',
    'referralValidate', 'referralInfo'],
  // ADMIN_API_KEY required → 403 { error: 'forbidden' } without it.
  admin: ['referralPayout', 'adminVerifyOtp', 'adminSetupOtp', 'adminStats', 'adminUsers', 'adminSubscriptions',
    'adminPayments', 'adminReferrals', 'adminPromoCodes', 'adminMessages', 'adminAiUsage', 'adminStarsDiagnostics',
    'adminStarsCanaryCheck', 'adminHabitSmokeTestCreate', 'adminHabitSmokeTestStatus', 'adminHabitSmokeTestDelete',
    'adminNotesDiagnostic'],
  // Partner session (HMAC token) required → 401 { error: 'unauthorized', code }.
  partner: ['partnerMe', 'partnerLink'],
  // Telegram Login Widget signature required → 401 { error: 'invalid_telegram_signature', code }.
  partnerLogin: ['partnerLogin'],
  // Public by design (a bot's @username is public).
  public: ['partnerBotInfo'],
};

function loadAiRouter() {
  const db = createMockDb({});
  const admin = { ...mockAdmin, auth: () => ({ verifyIdToken: async () => { throw Object.assign(new Error('bad'), { code: 'auth/argument-error' }); } }) };
  const fa = require.resolve('../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin } };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, 'api') + path.sep) && k !== fa) delete require.cache[k];
  }
  return { db, router: require('../ai/[action]') };
}

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

async function call(router, action, { method = 'POST', headers = {}, body = {} } = {}) {
  const r = mockRes();
  const quiet = ['log', 'warn', 'error'].map(k => [k, console[k]]);
  for (const [k] of quiet) console[k] = () => {};
  try {
    await router({ method, query: { action }, headers: { 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200) + 1}`, ...headers }, body, url: `/api/ai/${action}` }, r);
  } finally {
    for (const [k, fn] of quiet) console[k] = fn;
  }
  return r;
}

test('ai router: every known action is routed and guarded by its own authentication', async () => {
  process.env.ADMIN_API_KEY = 'test-admin-key';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_USERNAME;
  global.fetch = async () => { throw new Error('network is not allowed in this test'); };
  const { db, router } = loadAiRouter();

  for (const a of AI_ACTIONS.user) {
    const r = await call(router, a, { headers: {} });
    assert.equal(r.statusCode, 401, a);
    assert.deepEqual(r.body, { error: 'Unauthorized' }, a);
    const r2 = await call(router, a, { headers: { authorization: 'Bearer not-a-token' } });
    assert.equal(r2.statusCode, 401, `${a} with an invalid token`);
  }
  for (const a of AI_ACTIONS.admin) {
    const r = await call(router, a, { headers: { 'x-admin-key': 'wrong' } });
    assert.equal(r.statusCode, 403, a);
    assert.deepEqual(r.body, { error: 'forbidden' }, a);
  }
  for (const a of AI_ACTIONS.partner) {
    const r = await call(router, a);
    assert.equal(r.statusCode, 401, a);
    assert.equal(r.body.error, 'unauthorized', a);
    assert.equal(typeof r.body.code, 'string', a);
  }
  for (const a of AI_ACTIONS.partnerLogin) {
    const r = await call(router, a, { body: { id: 1, hash: 'x' } });
    assert.equal(r.statusCode, 401, a);
    assert.equal(r.body.error, 'invalid_telegram_signature', a);
  }
  for (const a of AI_ACTIONS.public) {
    const r = await call(router, a);
    assert.equal(r.statusCode, 200, a);
    assert.equal(r.body.ok, true, a);
    assert.equal(typeof r.body.botUsername, 'string', a);
  }
  assert.equal(db._store.size, 0, 'unauthenticated calls must not write anything');
});

test('ai router: unknown actions are 404, non-POST methods are 405', async () => {
  const { router } = loadAiRouter();
  const unknown = await call(router, 'chat');
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.body, { error: 'Unknown AI action: chat' });
  // Prototype keys must not resolve to handlers.
  for (const a of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await call(router, a);
    assert.equal(r.statusCode, 404, a);
  }
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await call(router, 'adminStats', { method });
    assert.equal(r.statusCode, 405, method);
    assert.deepEqual(r.body, { error: 'Method not allowed' });
  }
});

test('ai router: exactly the documented action set is routed', async () => {
  const { router } = loadAiRouter();
  const known = new Set(Object.values(AI_ACTIONS).flat());
  assert.equal(known.size, 29);
  // Anything not in the set must be a 404 — probe the names of internal helpers.
  for (const a of ['requireAuth', 'requireAdmin', 'adminUsersDebug', 'entityDelete', 'adminTotp', 'referralCreate']) {
    assert.equal((await call(router, a)).statusCode, 404, a);
  }
});

// Static checks for routers that this modernisation does not touch.
test('payment router: action set is unchanged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/payment/[action].js'), 'utf8');
  const actions = [...src.matchAll(/if \(action === '([a-zA-Z]+)'\)\s*return handle/g)].map(m => m[1]);
  assert.deepEqual(actions, ['create', 'callback', 'trial', 'starsPlans', 'starsCreate', 'starsSession', 'version']);
});

test('insights router: action set and methods are unchanged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'api/insights/[action].js'), 'utf8');
  assert.match(src, /action === 'list'\)[\s\S]{0,40}req\.method !== 'GET'/);
  assert.match(src, /action === 'dismiss'\)[\s\S]{0,40}req\.method !== 'POST'/);
});

test('cron router: job allow-list is unchanged', () => {
  const fa = require.resolve('../_lib/firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: createMockDb({}), admin: mockAdmin } };
  delete require.cache[require.resolve('../cron/[job]')];
  assert.deepEqual(require('../cron/[job]').JOBS, ['content-plan', 'content-publish', 'maintenance', 'insights']);
});
