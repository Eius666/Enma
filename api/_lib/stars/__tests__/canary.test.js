'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATHS = ['../canary', '../config'];
function reload(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}
function teardown(envKeys) {
  for (const k of envKeys) delete process.env[k];
  for (const p of MODULE_PATHS) { try { delete require.cache[require.resolve(p)]; } catch (_) {} }
}

test('canaryIds: parses a comma-separated numeric list, trims whitespace', () => {
  reload({ STARS_CANARY_TELEGRAM_IDS: ' 123, 456 ,789' });
  try {
    const { canaryIds } = require('../canary');
    const ids = canaryIds();
    assert.deepEqual([...ids].sort(), [123, 456, 789]);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('canaryIds: silently drops non-numeric entries — never guesses a username into an id', () => {
  reload({ STARS_CANARY_TELEGRAM_IDS: '123,owner_username,45a6,' });
  try {
    const { canaryIds } = require('../canary');
    assert.deepEqual([...canaryIds()], [123]);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('canaryIds: empty/unset env yields an empty set', () => {
  reload({});
  try {
    const { canaryIds, isCanaryConfigured } = require('../canary');
    assert.equal(canaryIds().size, 0);
    assert.equal(isCanaryConfigured(), false);
  } finally { teardown([]); }
});

test('isStarsEnabledForUser: global flag true enables EVERYONE, no id needed', () => {
  reload({ STARS_MINIAPP_ENABLED: 'true' });
  try {
    const { isStarsEnabledForUser } = require('../canary');
    assert.equal(isStarsEnabledForUser(123), true);
    assert.equal(isStarsEnabledForUser(null), true);
  } finally { teardown(['STARS_MINIAPP_ENABLED']); }
});

test('isStarsEnabledForUser: global flag false — only listed ids pass, no id at all fails closed', () => {
  reload({ STARS_CANARY_TELEGRAM_IDS: '555' });
  try {
    const { isStarsEnabledForUser } = require('../canary');
    assert.equal(isStarsEnabledForUser(555), true);
    assert.equal(isStarsEnabledForUser(999), false);
    assert.equal(isStarsEnabledForUser(null), false);
    assert.equal(isStarsEnabledForUser(undefined), false);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});

test('isStarsEnabledForUser: string vs number id are treated the same (Telegram ids arrive as numbers from initData)', () => {
  reload({ STARS_CANARY_TELEGRAM_IDS: '555' });
  try {
    const { isStarsEnabledForUser } = require('../canary');
    assert.equal(isStarsEnabledForUser('555'), true);
  } finally { teardown(['STARS_CANARY_TELEGRAM_IDS']); }
});
