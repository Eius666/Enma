'use strict';

// Policy checks on CI/CD config (no network):
//  - ci.yml has no production deploy / production secrets / production ids
//  - ci.yml triggers only on main
//  - every `firebase` command in package.json names its target project

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('ci.yml triggers only on push to main (+ manual)', () => {
  const on = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'));
  assert.match(on, /branches: \[main\]/);
  assert.ok(!/pull_request|schedule|tags:/.test(on));
});

test('ci.yml contains no deploy step, no secrets and no production identifiers', () => {
  assert.ok(!ci.includes('enma-4ea29'));
  assert.ok(!ci.includes('prj_sfP2tRu4Q7iM1v0RVu9oFFE5gdeX'));
  assert.ok(!/secrets\./.test(ci), 'CI must not use any secret');
  assert.ok(!/vercel\s+(deploy|--prod|pull)|--prod\b|npx[^\n]*vercel/i.test(ci), 'CI must not deploy (DEV is deployed by the Vercel Git Integration)');
  assert.ok(!/^\s{2}deploy/m.test(ci), 'no deploy job');
  assert.ok(!/firebase-tools[^\n]*deploy|firebase deploy/.test(ci));
  assert.match(ci, /Typecheck/);
  assert.match(ci, /Unit tests/);
  assert.match(ci, /Firestore rules \(emulator\)/);
  assert.match(ci, /Integration tests \(emulator\)/);
  assert.match(ci, /Production build/);
});

test('every firebase CLI command in package.json names a project explicitly', () => {
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (/(^|\s)firebase\s/.test(cmd)) assert.match(cmd, /--project\s+\S+/, `script ${name}`);
  }
});

test('prebuild runs the environment-isolation build guard', () => {
  assert.match(pkg.scripts.prebuild, /assertEnvIsolation\.js/);
});

test('.env.dev.example never carries a secret value and pins the DEV identifiers', () => {
  const text = fs.readFileSync(path.join(root, '.env.dev.example'), 'utf8');
  const val = (k) => (new RegExp(`^${k}=([^#\\n]*)`, 'm').exec(text) || [])[1]?.trim();
  for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'FIREBASE_SERVICE_ACCOUNT', 'CRON_SECRET', 'ADMIN_API_KEY', 'PARTNER_SESSION_SECRET', 'OPENROUTER_API_KEY']) {
    assert.equal(val(k), '', `${k} must be blank in the template`);
  }
  assert.equal(val('ENMA_ENV'), 'dev');
  assert.equal(val('DEV_FIREBASE_PROJECT_ID'), 'enmadev-aa7b1');
  assert.equal(val('DEV_TELEGRAM_BOT_ID'), '8952129105');
  assert.equal(val('DEV_VERCEL_PROJECT_ID'), 'prj_wwGqJR959AHCKURTDE20rRXrsb2c');
  assert.notEqual(val('DEV_VERCEL_PROJECT_ID'), 'prj_sfP2tRu4Q7iM1v0RVu9oFFE5gdeX');
});

// ── first-deploy preflight ──────────────────────────────────────────────────
const { runChecks, EXPECTED } = require('../../../scripts/dev-preflight');
const goodPreflightEnv = () => ({
  ENMA_ENV: 'dev', DEV_FIREBASE_PROJECT_ID: EXPECTED.firebaseProjectId, DEV_TELEGRAM_BOT_ID: EXPECTED.botId,
  DEV_VERCEL_PROJECT_ID: EXPECTED.vercelProjectId, DEV_ALLOWED_CHAT_IDS: '111',
  TELEGRAM_BOT_TOKEN: `${EXPECTED.botId}:fake-token`, TELEGRAM_BOT_USERNAME: EXPECTED.botUsername,
  TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(40), CRON_SECRET: 'c'.repeat(32), ADMIN_API_KEY: 'a', PARTNER_SESSION_SECRET: 'p',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: EXPECTED.firebaseProjectId, private_key: 'x' }),
  REACT_APP_FIREBASE_API_KEY: 'k', REACT_APP_FIREBASE_AUTH_DOMAIN: 'enmadev-aa7b1.firebaseapp.com',
  REACT_APP_FIREBASE_PROJECT_ID: EXPECTED.firebaseProjectId, REACT_APP_FIREBASE_STORAGE_BUCKET: 'enmadev-aa7b1.appspot.com',
  REACT_APP_FIREBASE_MESSAGING_SENDER_ID: '1', REACT_APP_FIREBASE_APP_ID: 'a',
  REACT_APP_URL: 'https://enma-l4lh.vercel.app', REACT_APP_BOT_USERNAME: EXPECTED.botUsername,
});
const failing = (env) => runChecks(env).filter((r) => !r.ok).map((r) => r.name);

test('preflight: a correct DEV configuration passes every check', () => {
  assert.deepEqual(failing(goodPreflightEnv()), []);
});

test('preflight: production values / missing values / forbidden keys are all caught', () => {
  const g = goodPreflightEnv;
  assert.ok(failing({ ...g(), FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'enma-4ea29' }) }).length > 0);
  assert.ok(failing({ ...g(), TELEGRAM_BOT_TOKEN: '555:other' }).length > 0);
  assert.ok(failing({ ...g(), DEV_VERCEL_PROJECT_ID: 'prj_sfP2tRu4Q7iM1v0RVu9oFFE5gdeX' }).length > 0);
  assert.ok(failing({ ...g(), PLATEGA_SECRET: 'x' }).length > 0);
  assert.ok(failing({ ...g(), TON_PAYMENT_WALLET: 'x' }).length > 0);
  assert.ok(failing({ ...g(), STARS_MINIAPP_ENABLED: 'true' }).length > 0);
  assert.ok(failing({ ...g(), TELEGRAM_WEBHOOK_SECRET: 'short' }).length > 0);
  assert.ok(failing({ ...g(), REACT_APP_URL: 'https://enma.su' }).length > 0);
  assert.ok(failing({ ...g(), REACT_APP_BOT_USERNAME: 'YourArc_bot' }).length > 0);
  const missing = g(); delete missing.CRON_SECRET;
  assert.ok(failing(missing).length > 0);
  assert.ok(failing({ ...g(), ADMIN_API_KEY: '[SENSITIVE]' }).length > 0);
});

test('preflight output never contains values', () => {
  const env = goodPreflightEnv();
  const text = JSON.stringify(runChecks(env));
  for (const k of ['TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'FIREBASE_SERVICE_ACCOUNT', 'CRON_SECRET']) {
    assert.ok(!text.includes(env[k]), k);
  }
});
