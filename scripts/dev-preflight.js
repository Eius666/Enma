'use strict';

// Pre-deploy gate for the first DEV deployment. Reads an env file kept OUTSIDE
// the repository (owner-provided) and checks it WITHOUT printing any value:
//   node scripts/dev-preflight.js --env-file /path/to/enma-dev.env
// Exit 0 only if every check passes. Pure local check — no network, no Firebase,
// no Vercel, no Telegram.
const fs = require('fs');
const path = require('path');
const { parseEnvFile } = require('./assertEnvIsolation');
const {
  PROD_FIREBASE_PROJECT_ID, PROD_VERCEL_PROJECT_ID, assertEnvironmentIsolation, assertClientConfig,
} = require('../api/_lib/envIsolation');

const EXPECTED = {
  vercelProjectId: 'prj_wwGqJR959AHCKURTDE20rRXrsb2c',
  firebaseProjectId: 'enmadev-aa7b1',
  botId: '8952129105',
  botUsername: 'Enmadevbot',
};
const REQUIRED = [
  'ENMA_ENV', 'DEV_FIREBASE_PROJECT_ID', 'DEV_TELEGRAM_BOT_ID', 'DEV_VERCEL_PROJECT_ID', 'DEV_ALLOWED_CHAT_IDS',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET', 'FIREBASE_SERVICE_ACCOUNT',
  'CRON_SECRET', 'ADMIN_API_KEY', 'PARTNER_SESSION_SECRET',
  'REACT_APP_FIREBASE_API_KEY', 'REACT_APP_FIREBASE_AUTH_DOMAIN', 'REACT_APP_FIREBASE_PROJECT_ID',
  'REACT_APP_FIREBASE_STORAGE_BUCKET', 'REACT_APP_FIREBASE_MESSAGING_SENDER_ID', 'REACT_APP_FIREBASE_APP_ID',
  'REACT_APP_URL', 'REACT_APP_BOT_USERNAME',
];
const FORBIDDEN = [/^PLATEGA_/, /^TON_/, /^TONCENTER_/, /^THREADS_/, /^STARS_/, /^TELEGRAM_CONTENT_CHANNEL_ID$/, /^CONTENT_ADMIN_CHAT_ID$/, /^LEGACY_STARS_/];

function serviceAccountProjectId(raw) {
  try {
    const t = String(raw).trim();
    const o = JSON.parse(t.startsWith('{') ? t : Buffer.from(t, 'base64').toString('utf8'));
    return o.project_id;
  } catch { return undefined; }
}

/** @returns {{name: string, ok: boolean}[]} — names only, never values. */
function runChecks(env) {
  const out = [];
  const add = (name, ok) => out.push({ name, ok: Boolean(ok) });
  const run = (name, fn) => { try { fn(); add(name, true); } catch (e) { add(`${name} [${e.code || 'error'}]`, false); } };

  for (const k of REQUIRED) add(`required variable present: ${k}`, env[k] && env[k] !== '[SENSITIVE]');
  add('DEV Vercel project id is the pinned DEV project', env.DEV_VERCEL_PROJECT_ID === EXPECTED.vercelProjectId);
  add('DEV Vercel project id differs from production', env.DEV_VERCEL_PROJECT_ID !== PROD_VERCEL_PROJECT_ID);
  add('DEV Firebase project id is the pinned DEV project', env.DEV_FIREBASE_PROJECT_ID === EXPECTED.firebaseProjectId);
  add('DEV Firebase project id differs from production', env.DEV_FIREBASE_PROJECT_ID !== PROD_FIREBASE_PROJECT_ID);
  add('DEV bot id is the pinned DEV bot', env.DEV_TELEGRAM_BOT_ID === EXPECTED.botId);
  add('bot token belongs to the DEV bot id', String(env.TELEGRAM_BOT_TOKEN || '').startsWith(`${EXPECTED.botId}:`));
  add('server bot username is the DEV bot', env.TELEGRAM_BOT_USERNAME === EXPECTED.botUsername);
  add('client bot username is the DEV bot', env.REACT_APP_BOT_USERNAME === EXPECTED.botUsername);
  add('service-account project_id is the DEV project', serviceAccountProjectId(env.FIREBASE_SERVICE_ACCOUNT) === EXPECTED.firebaseProjectId);
  add('webhook secret is at least 32 characters', String(env.TELEGRAM_WEBHOOK_SECRET || '').length >= 32);
  add('webhook secret differs from cron secret', env.TELEGRAM_WEBHOOK_SECRET !== env.CRON_SECRET);
  add('no forbidden payment/social/channel variables set', !Object.keys(env).some((k) => env[k] && FORBIDDEN.some((re) => re.test(k))));

  // Simulate the Vercel runtime: the project id Vercel would inject is the DEV one.
  const simulated = { ...env, VERCEL_ENV: 'production', VERCEL_PROJECT_ID: EXPECTED.vercelProjectId };
  run('server isolation guard passes (simulated Vercel runtime)', () =>
    assertEnvironmentIsolation({ serviceAccountProjectId: serviceAccountProjectId(env.FIREBASE_SERVICE_ACCOUNT), env: simulated }));
  run('client/build isolation guard passes', () => assertClientConfig(env));
  // Fail-closed self-test: the same config pointed at production MUST be refused.
  let refused = false;
  try { assertEnvironmentIsolation({ serviceAccountProjectId: PROD_FIREBASE_PROJECT_ID, env: simulated }); } catch { refused = true; }
  add('fail-closed self-test: production Firebase is refused', refused);
  refused = false;
  try { assertEnvironmentIsolation({ serviceAccountProjectId: serviceAccountProjectId(env.FIREBASE_SERVICE_ACCOUNT), env: { ...simulated, VERCEL_PROJECT_ID: PROD_VERCEL_PROJECT_ID } }); } catch { refused = true; }
  add('fail-closed self-test: production Vercel project is refused', refused);
  return out;
}

if (require.main === module) {
  const i = process.argv.indexOf('--env-file');
  const file = i >= 0 ? process.argv[i + 1] : null;
  if (!file) { console.error('usage: node scripts/dev-preflight.js --env-file <path outside the repo>'); process.exit(2); }
  const abs = path.resolve(file);
  if (abs.startsWith(path.resolve(__dirname, '..') + path.sep)) { console.error('✖ env file must live outside the repository'); process.exit(2); }
  const results = runChecks(parseEnvFile(fs.readFileSync(abs, 'utf8')));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n✖ ${failed} check(s) failed — do not deploy.` : '\n✔ all checks passed.');
  process.exit(failed ? 1 : 0);
}

module.exports = { runChecks, EXPECTED };
