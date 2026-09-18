'use strict';

/**
 * Unit tests for Migration A (semantic-only currency backfill).
 * Runs against in-memory fixtures — no Firestore connection needed.
 * Mirrors scripts/migrateLegacyCurrencySemantics.js's scan/apply logic using
 * the REAL resolveTransactionCurrency (the same resolver the production
 * script imports), so these tests fail if the resolver's behavior ever
 * silently changes.
 */

const assert = require('assert');
const { resolveTransactionCurrency } = require('../../api/_lib/finance/resolveLegacyCurrency');

const MIGRATION_VERSION = 'legacy-semantics-v1';

const C = {
  SKIP_ALREADY_HAS_CURRENCY: 'SKIP_ALREADY_HAS_CURRENCY',
  SKIP_ALREADY_MIGRATED:     'SKIP_ALREADY_MIGRATED',
  RESOLVED:                  'RESOLVED',
  UNKNOWN:                   'UNKNOWN',
};

// Mirrors scanUser()'s per-doc classification in the real script.
function classify(d) {
  if (d.currencyMigration?.version === MIGRATION_VERSION) return { tag: C.SKIP_ALREADY_MIGRATED };
  if (d.currency) return { tag: C.SKIP_ALREADY_HAS_CURRENCY };
  const resolved = resolveTransactionCurrency(d);
  if (resolved.currency === null) return { tag: C.UNKNOWN };
  return { tag: C.RESOLVED, resolvedCurrency: resolved.currency, confidence: resolved.confidence, reason: resolved.reason };
}

// Mirrors applyMigration()'s update payload shape — used to assert `amount`
// is structurally impossible to include.
function buildUpdatePayload(resolvedCurrency, confidence, reason) {
  return {
    currency: resolvedCurrency,
    currencyMigration: { version: MIGRATION_VERSION, migratedAt: new Date().toISOString(), method: 'storage_semantics', confidence, reason },
  };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

test('legacy Web transaction inside bug window → RESOLVED as USD', () => {
  const doc = { amount: 2000000, createdAt: { toMillis: () => Date.parse('2026-06-01T00:00:00Z') } };
  const r = classify(doc);
  assert.strictEqual(r.tag, C.RESOLVED);
  assert.strictEqual(r.resolvedCurrency, 'USD');
  assert.strictEqual(r.confidence, 'exact');
});

test('legacy Telegram transaction → RESOLVED as RUB', () => {
  const doc = { amount: 5000, source: 'telegram-bot' };
  const r = classify(doc);
  assert.strictEqual(r.tag, C.RESOLVED);
  assert.strictEqual(r.resolvedCurrency, 'RUB');
  assert.strictEqual(r.confidence, 'high');
});

test('genuinely unresolvable transaction → UNKNOWN, never guessed', () => {
  const doc = { amount: 9000 }; // no currency, no source, no timestamp
  const r = classify(doc);
  assert.strictEqual(r.tag, C.UNKNOWN);
});

test('transaction already carrying `currency` → SKIP_ALREADY_HAS_CURRENCY, never re-resolved', () => {
  const doc = { amount: 5000, currency: 'EUR' };
  const r = classify(doc);
  assert.strictEqual(r.tag, C.SKIP_ALREADY_HAS_CURRENCY);
});

test('idempotency: a doc already migrated is skipped on a second pass', () => {
  const doc = {
    amount: 2000000,
    currency: 'USD',
    currencyMigration: { version: MIGRATION_VERSION },
  };
  const r = classify(doc);
  assert.strictEqual(r.tag, C.SKIP_ALREADY_MIGRATED);
});

test('update payload structurally never includes `amount` — lossless by construction', () => {
  const payload = buildUpdatePayload('USD', 'exact', 'legacy_web_usd_baseline');
  assert.strictEqual('amount' in payload, false);
  assert.strictEqual(payload.currency, 'USD');
});

test('mixed dataset: only currency-less, resolvable docs are selected for migration', () => {
  const docs = [
    { amount: 100, currency: 'RUB' },                                  // skip: already has currency
    { amount: 200, source: 'telegram-bot' },                           // resolve: RUB
    { amount: 300, createdAt: { toMillis: () => Date.parse('2026-03-01T00:00:00Z') } }, // resolve: USD
    { amount: 400 },                                                   // unknown
    { amount: 500, currency: 'EUR', currencyMigration: { version: MIGRATION_VERSION } }, // already migrated
  ];
  const results = docs.map(classify);
  const toMigrate = results.filter(r => r.tag === C.RESOLVED);
  assert.strictEqual(toMigrate.length, 2);
  assert.strictEqual(results.filter(r => r.tag === C.UNKNOWN).length, 1);
  assert.strictEqual(results.filter(r => r.tag === C.SKIP_ALREADY_HAS_CURRENCY).length, 1);
  assert.strictEqual(results.filter(r => r.tag === C.SKIP_ALREADY_MIGRATED).length, 1);
});

test('backup record: self-contained rollback data (id, previous currency, new currency, migration version) — never amount', () => {
  function buildBackupRecord(id, resolvedCurrency, confidence, reason) {
    return {
      transactionId: id,
      previousCurrency: null, // this migration only ever selects currency-less docs
      newCurrency: resolvedCurrency,
      confidence,
      reason,
      migrationVersion: MIGRATION_VERSION,
    };
  }
  const backup = buildBackupRecord('tx1', 'USD', 'exact', 'legacy_web_usd_baseline');
  assert.strictEqual(backup.transactionId, 'tx1');
  assert.strictEqual(backup.previousCurrency, null);
  assert.strictEqual(backup.newCurrency, 'USD');
  assert.strictEqual(backup.migrationVersion, MIGRATION_VERSION);
  assert.strictEqual('amount' in backup, false);
});

test('rollback restore logic: previousCurrency=null means delete the field, not set it to null', () => {
  const backup = { previousCurrency: null };
  const restoreValue = (backup.previousCurrency === null || backup.previousCurrency === undefined)
    ? { _delete: true }
    : backup.previousCurrency;
  assert.deepEqual(restoreValue, { _delete: true });
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('─'.repeat(50));
if (failed > 0) process.exit(1);
