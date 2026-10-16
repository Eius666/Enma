'use strict';

// DEV/PRODUCTION isolation. Pure functions — no network, no Firebase.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROD_FIREBASE_PROJECT_ID, PROD_VERCEL_PROJECT_ID,
  assertEnvironmentIsolation, assertClientConfig, isChatAllowed, getEnvName,
} = require('../envIsolation');
const { buildArgs } = require('../../../scripts/firebase-dev');

const DEV_ID = 'enma-dev-test';
const DEV_BOT = '1234567890';
const goodDev = (over = {}) => ({
  ENMA_ENV: 'dev',
  DEV_FIREBASE_PROJECT_ID: DEV_ID,
  DEV_TELEGRAM_BOT_ID: DEV_BOT,
  TELEGRAM_BOT_TOKEN: `${DEV_BOT}:fake-token-value`,
  TELEGRAM_BOT_USERNAME: 'EnmaDev_bot',
  TELEGRAM_WEBHOOK_SECRET: 'dev-webhook-secret-0123456789',
  DEV_ALLOWED_CHAT_IDS: '111, 222',
  CRON_SECRET: 'dev-cron-secret-0123456789',
  REACT_APP_FIREBASE_PROJECT_ID: DEV_ID,
  REACT_APP_URL: 'https://enma-dev.vercel.app',
  REACT_APP_BOT_USERNAME: 'EnmaDev_bot',
  VERCEL_PROJECT_ID: 'prj_dev_other',
  DEV_VERCEL_PROJECT_ID: 'prj_dev_other',
  ...over,
});
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
const check = (env, projectId = DEV_ID) => code(() => assertEnvironmentIsolation({ serviceAccountProjectId: projectId, env }));

test('production: ENMA_ENV unset → nothing extra enforced (unchanged behaviour)', () => {
  assert.equal(code(() => assertEnvironmentIsolation({ serviceAccountProjectId: PROD_FIREBASE_PROJECT_ID, env: {} })), null);
  assert.equal(code(() => assertEnvironmentIsolation({ serviceAccountProjectId: PROD_FIREBASE_PROJECT_ID, env: { VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID } })), null);
  assert.equal(isChatAllowed(999, {}), true);
  assert.equal(isChatAllowed(undefined, {}), true);
});

test('invalid ENMA_ENV fails closed', () => {
  assert.equal(check({ ENMA_ENV: 'staging' }), 'ENMA_ENV_INVALID');
  assert.throws(() => getEnvName({ ENMA_ENV: 'prod ' + 'x' }));
});

test('prod Firebase credentials on a non-production Vercel project → refused even without ENMA_ENV', () => {
  assert.equal(check({ VERCEL_PROJECT_ID: 'prj_other' }, PROD_FIREBASE_PROJECT_ID), 'PROD_FIREBASE_ON_NON_PROD_VERCEL_PROJECT');
});

test('DEV happy path passes', () => {
  assert.equal(check(goodDev()), null);
});

test('DEV with production Firebase project id → refused', () => {
  // caught by the Vercel-project cross-check first when the project id is known…
  assert.equal(check(goodDev(), PROD_FIREBASE_PROJECT_ID), 'PROD_FIREBASE_ON_NON_PROD_VERCEL_PROJECT');
  // …and by the DEV rule itself when it is not.
  assert.equal(check(goodDev({ VERCEL_PROJECT_ID: undefined }), PROD_FIREBASE_PROJECT_ID), 'DEV_USES_PROD_FIREBASE');
  assert.equal(check(goodDev({ VERCEL_PROJECT_ID: undefined, DEV_FIREBASE_PROJECT_ID: PROD_FIREBASE_PROJECT_ID }), PROD_FIREBASE_PROJECT_ID), 'DEV_USES_PROD_FIREBASE');
});

test('DEV on the production Vercel project → refused', () => {
  assert.equal(check(goodDev({ VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID })), 'DEV_ON_PROD_VERCEL_PROJECT');
});

test('DEV Firebase project must be declared and match the credentials', () => {
  assert.equal(check(goodDev({ DEV_FIREBASE_PROJECT_ID: '' })), 'DEV_FIREBASE_PROJECT_NOT_DECLARED');
  assert.equal(check(goodDev({ DEV_FIREBASE_PROJECT_ID: 'other-dev' })), 'DEV_FIREBASE_PROJECT_MISMATCH');
  assert.equal(check(goodDev(), null), 'DEV_FIREBASE_PROJECT_UNKNOWN');
});

test('DEV Telegram: token must belong to the declared DEV bot; prod username refused', () => {
  assert.equal(check(goodDev({ TELEGRAM_BOT_TOKEN: '999:other-bot-token' })), 'DEV_BOT_TOKEN_NOT_DEV_BOT');
  assert.equal(check(goodDev({ DEV_TELEGRAM_BOT_ID: '' })), 'DEV_TELEGRAM_BOT_ID_NOT_DECLARED');
  assert.equal(check(goodDev({ TELEGRAM_BOT_USERNAME: 'YourArc_bot' })), 'DEV_USES_PROD_BOT_USERNAME');
  assert.equal(check(goodDev({ TELEGRAM_BOT_USERNAME: 'yourarc_BOT' })), 'DEV_USES_PROD_BOT_USERNAME');
});

test('DEV requires its own webhook secret and an allow-list of test chats', () => {
  assert.equal(check(goodDev({ TELEGRAM_WEBHOOK_SECRET: '' })), 'DEV_WEBHOOK_SECRET_MISSING');
  assert.equal(check(goodDev({ TELEGRAM_WEBHOOK_SECRET: 'short' })), 'DEV_WEBHOOK_SECRET_MISSING');
  assert.equal(check(goodDev({ DEV_ALLOWED_CHAT_IDS: ' , ' })), 'DEV_ALLOWED_CHAT_IDS_MISSING');
});

test('DEV client config: prod Firebase / prod URL refused', () => {
  assert.equal(check(goodDev({ REACT_APP_FIREBASE_PROJECT_ID: PROD_FIREBASE_PROJECT_ID })), 'DEV_CLIENT_USES_PROD_FIREBASE');
  assert.equal(check(goodDev({ REACT_APP_FIREBASE_PROJECT_ID: 'another' })), 'DEV_CLIENT_FIREBASE_PROJECT_MISMATCH');
  assert.equal(check(goodDev({ REACT_APP_URL: 'https://enma.su' })), 'DEV_URL_IS_PROD');
  assert.equal(check(goodDev({ REACT_APP_URL: 'https://www.enma.su/' })), 'DEV_URL_IS_PROD');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_URL: 'https://enma.su/x' }))), 'DEV_URL_IS_PROD');
  // production builds are not constrained
  assert.equal(code(() => assertClientConfig({ REACT_APP_URL: 'https://enma.su', REACT_APP_FIREBASE_PROJECT_ID: PROD_FIREBASE_PROJECT_ID })), null);
});

test('DEV payments: credentials refused unless explicitly opted in', () => {
  assert.equal(check(goodDev({ PLATEGA_MERCHANT_ID: 'x' })), 'DEV_HAS_PLATEGA_CREDENTIALS');
  assert.equal(check(goodDev({ PLATEGA_SECRET: 'x' })), 'DEV_HAS_PLATEGA_CREDENTIALS');
  assert.equal(check(goodDev({ PLATEGA_SECRET: 'x', DEV_PLATEGA_SANDBOX: 'true' })), null);
  assert.equal(check(goodDev({ TON_PAYMENT_WALLET: 'x' })), 'DEV_HAS_TON_CREDENTIALS');
  assert.equal(check(goodDev({ TONCENTER_API_KEY: 'x' })), 'DEV_HAS_TON_CREDENTIALS');
});

test('DEV chat allow-list', () => {
  const env = goodDev();
  assert.equal(isChatAllowed(111, env), true);
  assert.equal(isChatAllowed('222', env), true);
  assert.equal(isChatAllowed(333, env), false);
  assert.equal(isChatAllowed(undefined, env), false);
  assert.equal(isChatAllowed(111, goodDev({ DEV_ALLOWED_CHAT_IDS: '' })), false);
});

test('errors never contain env values', () => {
  const secret = 'dev-webhook-secret-0123456789';
  try { check(goodDev({ TELEGRAM_BOT_TOKEN: '999:SECRETVALUE' })); } catch (_) {}
  try {
    assertEnvironmentIsolation({ serviceAccountProjectId: DEV_ID, env: goodDev({ TELEGRAM_BOT_TOKEN: '999:SECRETVALUE' }) });
  } catch (e) {
    assert.ok(!e.message.includes('SECRETVALUE'));
    assert.ok(!e.message.includes(secret));
  }
});

test('firebase-dev wrapper: explicit project, never production, no override', () => {
  assert.deepEqual(buildArgs(['deploy', '--only', 'firestore:rules'], { DEV_FIREBASE_PROJECT_ID: DEV_ID }),
    ['deploy', '--only', 'firestore:rules', '--project', DEV_ID]);
  assert.throws(() => buildArgs(['deploy'], {}));
  assert.throws(() => buildArgs(['deploy'], { DEV_FIREBASE_PROJECT_ID: PROD_FIREBASE_PROJECT_ID }));
  assert.throws(() => buildArgs(['deploy', '--project', PROD_FIREBASE_PROJECT_ID], { DEV_FIREBASE_PROJECT_ID: DEV_ID }));
});

test('webhook handler (DEV): update from a non-allowed chat is ignored with 200 and not processed', async (t) => {
  const { createMockDb, mockAdmin } = require('../evals/fixtures');
  const keys = ['ENMA_ENV', 'DEV_ALLOWED_CHAT_IDS', 'TELEGRAM_WEBHOOK_SECRET', 'VERCEL_ENV', 'TELEGRAM_BOT_TOKEN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  Object.assign(process.env, { ENMA_ENV: 'dev', DEV_ALLOWED_CHAT_IDS: '111', TELEGRAM_WEBHOOK_SECRET: 'dev-webhook-secret-0123456789', VERCEL_ENV: 'preview', TELEGRAM_BOT_TOKEN: 't' });

  const fa = require.resolve('../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: createMockDb({}), admin: mockAdmin } };
  for (const p of ['../../telegram/webhook', '../verifyWebhookSig', '../envIsolation']) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
  const handler = require('../../telegram/webhook');
  t.after(() => { delete require.cache[fa]; });

  const origFetch = global.fetch; const calls = [];
  global.fetch = async (...a) => { calls.push(a); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  t.after(() => { global.fetch = origFetch; });

  const run = async (chatId) => {
    const res = { statusCode: null, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'dev-webhook-secret-0123456789', 'x-forwarded-for': '203.0.113.7' },
      body: { callback_query: { id: 'c', data: 'noop', from: { id: chatId } } } }, res);
    return res.statusCode;
  };
  assert.equal(await run(999), 200);
  assert.equal(calls.length, 0, 'non-allowed chat must not trigger any outbound Telegram call');
  assert.equal(await run(111), 200);
  assert.ok(calls.some(([u]) => String(u).includes('answerCallbackQuery')), 'allowed chat is processed');
});

test('DEV on Vercel without a visible project id → refused (cannot prove it is not production)', () => {
  assert.equal(check(goodDev({ VERCEL_ENV: 'production', VERCEL_PROJECT_ID: undefined })), 'DEV_VERCEL_PROJECT_ID_UNAVAILABLE');
  assert.equal(check(goodDev({ VERCEL_ENV: 'production' })), null);
});

test('DEV requires explicit client parameters and rejects prod storage / auth domain', () => {
  assert.equal(code(() => assertClientConfig(goodDev({ DEV_FIREBASE_PROJECT_ID: '' }))), 'DEV_FIREBASE_PROJECT_NOT_DECLARED');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_FIREBASE_PROJECT_ID: '' }))), 'DEV_CLIENT_FIREBASE_PROJECT_MISSING');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_URL: '' }))), 'DEV_CLIENT_URL_MISSING');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_FIREBASE_AUTH_DOMAIN: 'enma-4ea29.firebaseapp.com' }))), 'DEV_CLIENT_USES_PROD_FIREBASE');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_FIREBASE_STORAGE_BUCKET: 'enma-4ea29.appspot.com' }))), 'DEV_CLIENT_USES_PROD_FIREBASE');
  assert.equal(check(goodDev({ FIREBASE_STORAGE_BUCKET: 'enma-4ea29.appspot.com' })), 'DEV_USES_PROD_STORAGE_BUCKET');
});

test('DEV must declare bot usernames explicitly (defaults would fall back to the production bot)', () => {
  assert.equal(check(goodDev({ TELEGRAM_BOT_USERNAME: '' })), 'DEV_BOT_USERNAME_NOT_DECLARED');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_BOT_USERNAME: '' }))), 'DEV_CLIENT_BOT_USERNAME_MISSING');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_BOT_USERNAME: 'YourArc_bot' }))), 'DEV_CLIENT_USES_PROD_BOT');
});

test('firebase-dev wrapper: deploy is limited to explicit firestore targets', () => {
  const env = { DEV_FIREBASE_PROJECT_ID: DEV_ID };
  assert.throws(() => buildArgs(['deploy'], env));
  assert.throws(() => buildArgs(['deploy', '--only', 'functions'], env));
  assert.throws(() => buildArgs(['deploy', '--only', 'firestore:rules,hosting'], env));
  assert.deepEqual(buildArgs(['deploy', '--only', 'firestore:rules,firestore:indexes'], env).slice(-2), ['--project', DEV_ID]);
});

test('build guard merges CRA .env files (production values in .env.local cannot slip into a DEV bundle)', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { mergeCraEnv } = require('../../../scripts/assertEnvIsolation');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enma-env-'));
  fs.writeFileSync(path.join(dir, '.env.local'),
    'REACT_APP_FIREBASE_AUTH_DOMAIN=enma-4ea29.firebaseapp.com\nREACT_APP_TONCONNECT_MANIFEST="https://enma-silk.vercel.app/tonconnect-manifest.json"\n# comment\n');
  const shell = goodDev();
  const merged = mergeCraEnv(dir, shell);
  assert.equal(merged.REACT_APP_FIREBASE_AUTH_DOMAIN, 'enma-4ea29.firebaseapp.com'); // from file
  assert.equal(merged.REACT_APP_FIREBASE_PROJECT_ID, DEV_ID);                        // shell wins / present
  assert.equal(code(() => assertClientConfig(merged)), 'DEV_CLIENT_USES_PROD_FIREBASE');
  // shell value overrides the file
  assert.equal(mergeCraEnv(dir, { ...shell, REACT_APP_FIREBASE_AUTH_DOMAIN: 'dev.firebaseapp.com' }).REACT_APP_FIREBASE_AUTH_DOMAIN, 'dev.firebaseapp.com');
  assert.equal(code(() => assertClientConfig({ ...merged, REACT_APP_FIREBASE_AUTH_DOMAIN: 'dev.firebaseapp.com' })), 'DEV_CLIENT_TONCONNECT_IS_PROD');
  assert.equal(code(() => assertClientConfig(goodDev({ REACT_APP_TONCONNECT_MANIFEST: 'https://enma-dev.vercel.app/tonconnect-manifest.json' }))), null);
});

test('DEV requires CRON_SECRET (cron routes are open when it is unset)', () => {
  assert.equal(check(goodDev({ CRON_SECRET: '' })), 'DEV_CRON_SECRET_MISSING');
  assert.equal(check(goodDev({ CRON_SECRET: 'short' })), 'DEV_CRON_SECRET_MISSING');
});

test('DEV on Vercel: running project must equal the declared DEV project id', () => {
  const on = (o) => goodDev({ VERCEL_ENV: 'production', ...o });
  assert.equal(check(on({})), null);
  assert.equal(check(on({ DEV_VERCEL_PROJECT_ID: '' })), 'DEV_VERCEL_PROJECT_NOT_DECLARED');
  assert.equal(check(on({ DEV_VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID })), 'DEV_VERCEL_PROJECT_NOT_DECLARED');
  assert.equal(check(on({ VERCEL_PROJECT_ID: 'prj_someone_else' })), 'DEV_VERCEL_PROJECT_MISMATCH');
  assert.equal(check(on({ VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID })), 'DEV_ON_PROD_VERCEL_PROJECT');
});

test('vercel-dev wrapper: target only from env, never production, never a linked or .env* directory', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { check: vcheck } = require('../../../scripts/vercel-dev');
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'enma-vc-'));
  const ok = { DEV_VERCEL_PROJECT_ID: 'prj_devproject1', VERCEL_ORG_ID: 'team_abc123' };
  assert.equal(vcheck(['env', 'ls'], ok, clean).VERCEL_PROJECT_ID, 'prj_devproject1');
  assert.throws(() => vcheck(['env', 'ls'], { ...ok, DEV_VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID }, clean), /production/);
  assert.throws(() => vcheck(['env', 'ls'], { VERCEL_ORG_ID: 'team_abc123' }, clean));
  assert.throws(() => vcheck(['env', 'ls'], { DEV_VERCEL_PROJECT_ID: 'prj_devproject1' }, clean));
  assert.throws(() => vcheck(['env', 'rm', 'X'], ok, clean), /not allowed/);
  assert.throws(() => vcheck(['deploy', '--prod'], ok, clean), /not allowed/); // DEV deploys only via the Git Integration
  assert.throws(() => vcheck(['alias', 'set', 'a', 'enma-silk.vercel.app'], ok, clean), /not allowed/);
  assert.throws(() => vcheck(['env', 'ls', '--scope', 'x'], ok, clean), /--scope/);
  fs.mkdirSync(path.join(clean, '.vercel'));
  assert.throws(() => vcheck(['env', 'ls'], ok, clean), /\.vercel/);
  const clean2 = fs.mkdtempSync(path.join(os.tmpdir(), 'enma-vc-'));
  fs.writeFileSync(path.join(clean2, '.env.local'), 'X=1');
  assert.throws(() => vcheck(['env', 'ls'], ok, clean2), /\.env/);
  // (a developer checkout linked to production is refused by the .vercel rule above; a clean CI checkout has no link, so that is not asserted here)
});
