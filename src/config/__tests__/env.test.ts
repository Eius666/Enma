import { test } from 'node:test';
import assert from 'node:assert/strict';

// See TELEGRAM_PASSWORDLESS_AUTOAUTH audit, targeted-recovery round: a local
// `vercel build` (unlike a full remote `vercel --prod` deploy) fetches env
// vars through the CLI path that masks any Sensitive-marked variable as the
// literal string "[SENSITIVE]" — which silently became the "real" Firebase
// apiKey in the client bundle for this entire session, surfacing only as
// Firebase's own confusing `auth/api-key-not-valid` error. These tests cover
// src/config/env.ts's defensive guard against that exact failure mode.
//
// Each test imports env.ts fresh via a cache-busting query string (Node's
// ESM loader caches by full resolved URL, so this forces a new module
// evaluation per test instead of reusing the first run's already-thrown/
// already-resolved module).

const REQUIRED_KEYS = [
  'REACT_APP_FIREBASE_API_KEY', 'REACT_APP_FIREBASE_AUTH_DOMAIN', 'REACT_APP_FIREBASE_PROJECT_ID',
  'REACT_APP_FIREBASE_STORAGE_BUCKET', 'REACT_APP_FIREBASE_MESSAGING_SENDER_ID', 'REACT_APP_FIREBASE_APP_ID',
];

function setFakeEnv(overrides: Record<string, string> = {}) {
  for (const k of REQUIRED_KEYS) process.env[k] = overrides[k] ?? `fake-value-for-${k}`;
}
function clearEnv() {
  for (const k of REQUIRED_KEYS) delete process.env[k];
  delete process.env.REACT_APP_URL;
  delete process.env.REACT_APP_CLIENT_REMINDERS;
}
function freshImport() {
  return import(`../env.ts?case=${Date.now()}-${Math.random()}`);
}

test('env: a real-looking value passes through required()', async () => {
  setFakeEnv({ REACT_APP_FIREBASE_API_KEY: 'AIzaSyRealLookingTestValue1234567890' });
  try {
    const mod: any = await freshImport();
    assert.equal(mod.firebaseConfig.apiKey, 'AIzaSyRealLookingTestValue1234567890');
  } finally { clearEnv(); }
});

test('env: the masked "[SENSITIVE]" placeholder throws instead of being silently accepted as the apiKey', async () => {
  setFakeEnv({ REACT_APP_FIREBASE_API_KEY: '[SENSITIVE]' });
  try {
    await assert.rejects(freshImport(), /\[SENSITIVE\]/);
  } finally { clearEnv(); }
});

test('env: a missing required var throws a clear error, not a silent undefined apiKey', async () => {
  clearEnv();
  try {
    await assert.rejects(freshImport(), /Missing required environment variable/);
  } finally { clearEnv(); }
});

test('env: optional() falls back to its default when masked, never returns the literal placeholder', async () => {
  setFakeEnv();
  process.env.REACT_APP_URL = '[SENSITIVE]';
  try {
    const mod: any = await freshImport();
    assert.notEqual(mod.env.appUrl, '[SENSITIVE]');
  } finally { clearEnv(); }
});

test('env: optional() returns the real value when it is a normal string', async () => {
  setFakeEnv();
  process.env.REACT_APP_URL = 'https://example.test';
  try {
    const mod: any = await freshImport();
    assert.equal(mod.env.appUrl, 'https://example.test');
  } finally { clearEnv(); }
});
