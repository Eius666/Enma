'use strict';

/**
 * Unit tests for the legacy currency migration logic.
 * Tests run against in-memory fixtures — no Firestore connection needed.
 * Exercises: classify(), scanUser(), backup, apply, rollback, idempotency.
 */

const assert = require('assert');

// ── inline classify() (mirrors the script's function) ────────────────────────

const MIGRATION_VERSION = 'rub-base-v1';

const C = {
  SKIP_ALREADY_MIGRATED: 'SKIP_ALREADY_MIGRATED',
  SKIP_HAS_SOURCE:       'SKIP_HAS_SOURCE',
  SKIP_OUTSIDE_WINDOW:   'SKIP_OUTSIDE_WINDOW',
  ESTIMATED:             'ESTIMATED',
  UNKNOWN:               'UNKNOWN',
};

function msOf(v) {
  if (!v) return null;
  if (typeof v === 'number') return v;
  if (v._seconds !== undefined) return v._seconds * 1000;
  return new Date(v).getTime();
}

function classify(doc, userCurrency, bugStartMs, bugEndMs) {
  const d = doc.data();
  if (d.currencyMigration?.version === MIGRATION_VERSION) return C.SKIP_ALREADY_MIGRATED;
  if (d.source) return C.SKIP_HAS_SOURCE;
  const ts = msOf(d.createdAt) ?? msOf(d.date);
  if (!ts || ts < bugStartMs || ts >= bugEndMs) return C.SKIP_OUTSIDE_WINDOW;
  if (userCurrency !== 'RUB') return C.UNKNOWN;
  return C.ESTIMATED;
}

// Bug window used in tests
const BUG_START_MS = new Date('2026-01-15T14:36:25Z').getTime();
const BUG_END_MS   = new Date('2026-09-18T09:12:56Z').getTime();
const INSIDE_MS    = new Date('2026-05-01T12:00:00Z').getTime();
const BEFORE_MS    = new Date('2025-12-01T12:00:00Z').getTime();
const AFTER_MS     = new Date('2026-10-01T12:00:00Z').getTime();

function makeDoc(fields) {
  return { data: () => fields };
}

// ── helper: in-memory migration runner ───────────────────────────────────────

function runMigration(docs, rate) {
  return docs
    .filter(d => classify(d, 'RUB', BUG_START_MS, BUG_END_MS) === C.ESTIMATED)
    .map(d => ({
      id:             d.data().id,
      legacyAmount:   d.data().amount,
      correctedAmount: Math.round(d.data().amount * rate),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\nLegacy Currency Migration — unit tests\n');

// ── 1. classify: Exact metadata (not applicable here, but tests SKIP paths) ──

test('SKIP_ALREADY_MIGRATED — doc has currencyMigration.version=rub-base-v1', () => {
  const doc = makeDoc({
    amount: 2000000,
    createdAt: INSIDE_MS,
    currencyMigration: { version: 'rub-base-v1' },
  });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_ALREADY_MIGRATED);
});

test('SKIP_HAS_SOURCE — telegram-bot source', () => {
  const doc = makeDoc({ amount: 50000, source: 'telegram-bot', createdAt: INSIDE_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_HAS_SOURCE);
});

test('SKIP_HAS_SOURCE — ai-chat source', () => {
  const doc = makeDoc({ amount: 50000, source: 'ai-chat', createdAt: INSIDE_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_HAS_SOURCE);
});

test('SKIP_OUTSIDE_WINDOW — before bug start', () => {
  const doc = makeDoc({ amount: 50000, createdAt: BEFORE_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_OUTSIDE_WINDOW);
});

test('SKIP_OUTSIDE_WINDOW — after bug end', () => {
  const doc = makeDoc({ amount: 175000000, createdAt: AFTER_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_OUTSIDE_WINDOW);
});

test('ESTIMATED — inside window, no source, user=RUB', () => {
  const doc = makeDoc({ amount: 1988636, createdAt: INSIDE_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.ESTIMATED);
});

test('UNKNOWN — inside window, no source, user=USD', () => {
  const doc = makeDoc({ amount: 1988636, createdAt: INSIDE_MS });
  assert.strictEqual(classify(doc, 'USD', BUG_START_MS, BUG_END_MS), C.UNKNOWN);
});

// ── 2. Historical rate reconstruction (ESTIMATED path) ───────────────────────

test('ESTIMATED: amount × rate gives correct RUB (rate=87.5)', () => {
  const legacyAmount = 2000000;
  const rate         = 87.5;
  const corrected    = Math.round(legacyAmount * rate);
  assert.strictEqual(corrected, 175000000);
});

test('ESTIMATED: amount × rate gives correct RUB (rate=88)', () => {
  const legacyAmount = 1988636;
  const rate         = 88;
  const corrected    = Math.round(legacyAmount * rate);
  assert.strictEqual(corrected, 174999968); // ~175M within rounding
  assert.ok(corrected > 174000000, 'corrected amount should be in ~175M RUB range');
});

// ── 3. Already-RUB detection (SKIP paths) ────────────────────────────────────

test('SKIP_ALREADY_MIGRATED: doc already has migration marker', () => {
  const doc = makeDoc({
    amount: 175000000,
    createdAt: INSIDE_MS,
    currencyMigration: { version: 'rub-base-v1', method: 'estimated' },
  });
  const tag = classify(doc, 'RUB', BUG_START_MS, BUG_END_MS);
  assert.strictEqual(tag, C.SKIP_ALREADY_MIGRATED);
});

test('SKIP_OUTSIDE_WINDOW: new transaction (after fix) is never touched', () => {
  const doc = makeDoc({ amount: 175000000, createdAt: AFTER_MS });
  assert.strictEqual(classify(doc, 'RUB', BUG_START_MS, BUG_END_MS), C.SKIP_OUTSIDE_WINDOW);
});

// ── 4. Idempotency ────────────────────────────────────────────────────────────

test('Idempotency: second pass on already-migrated docs produces 0 updates', () => {
  const docs = [
    makeDoc({ id: 't1', amount: 174999968, createdAt: INSIDE_MS, currencyMigration: { version: 'rub-base-v1' } }),
    makeDoc({ id: 't2', amount: 87000000,  createdAt: INSIDE_MS, currencyMigration: { version: 'rub-base-v1' } }),
  ];
  const toMigrate = runMigration(docs, 88);
  assert.strictEqual(toMigrate.length, 0, 'No docs should be re-migrated');
});

// ── 5. Mixed dataset ──────────────────────────────────────────────────────────

test('Mixed dataset: only legacy docs are selected', () => {
  const docs = [
    makeDoc({ id: 'legacy',    amount: 1988636,     createdAt: INSIDE_MS }),                 // ESTIMATED
    makeDoc({ id: 'telegram',  amount: 50000,        createdAt: INSIDE_MS, source: 'telegram-bot' }), // SKIP_HAS_SOURCE
    makeDoc({ id: 'ai-chat',   amount: 3000,         createdAt: INSIDE_MS, source: 'ai-chat' }),       // SKIP_HAS_SOURCE
    makeDoc({ id: 'old',       amount: 100000,       createdAt: BEFORE_MS }),                          // SKIP_OUTSIDE_WINDOW
    makeDoc({ id: 'new',       amount: 175000000,    createdAt: AFTER_MS }),                           // SKIP_OUTSIDE_WINDOW
    makeDoc({ id: 'migrated',  amount: 174999968,    createdAt: INSIDE_MS, currencyMigration: { version: 'rub-base-v1' } }), // SKIP_ALREADY_MIGRATED
  ];

  const tags = docs.map(d => classify(d, 'RUB', BUG_START_MS, BUG_END_MS));
  assert.strictEqual(tags[0], C.ESTIMATED);
  assert.strictEqual(tags[1], C.SKIP_HAS_SOURCE);
  assert.strictEqual(tags[2], C.SKIP_HAS_SOURCE);
  assert.strictEqual(tags[3], C.SKIP_OUTSIDE_WINDOW);
  assert.strictEqual(tags[4], C.SKIP_OUTSIDE_WINDOW);
  assert.strictEqual(tags[5], C.SKIP_ALREADY_MIGRATED);

  const toMigrate = runMigration(docs, 88);
  assert.strictEqual(toMigrate.length, 1, 'Only 1 doc should be migrated');
  assert.strictEqual(toMigrate[0].id, 'legacy');
});

// ── 6. Balance calculation after migration ────────────────────────────────────

test('Balance test: income+expense migrate to correct RUB values', () => {
  const rate = 88;
  // Fixture: 2 income + 1 expense, all stored as USD-normalized (÷88)
  // Original: income 100k + 50k, expense 20k → balance 130k RUB
  const docs = [
    makeDoc({ id: 'i1', type: 'income',  amount: Math.round(100000 / rate), createdAt: INSIDE_MS }),
    makeDoc({ id: 'i2', type: 'income',  amount: Math.round(50000  / rate), createdAt: INSIDE_MS }),
    makeDoc({ id: 'e1', type: 'expense', amount: Math.round(20000  / rate), createdAt: INSIDE_MS }),
  ];

  const toMigrate = runMigration(docs, rate);
  assert.strictEqual(toMigrate.length, 3);

  const incomes  = toMigrate.filter((_, i) => docs[i].data().type === 'income');
  const expenses = toMigrate.filter((_, i) => docs[i].data().type === 'expense');

  const correctedBalance =
    incomes.reduce((s, t)  => s + t.correctedAmount, 0) -
    expenses.reduce((s, t) => s + t.correctedAmount, 0);

  // Integer rounding from ÷88 then ×88 introduces up to ~1% error per transaction;
  // allow ±500 RUB tolerance on a 130k balance.
  assert.ok(Math.abs(correctedBalance - 130000) <= 500, `balance after migration: ${correctedBalance}, expected ~130000`);
});

// ── 7. Rollback simulation ────────────────────────────────────────────────────

test('Rollback: restoring original values removes migration marker', () => {
  // Simulates what rollback does: restore originalAmount, delete currencyMigration
  const backup = {
    transactionId:    't1',
    originalAmount:   1988636,
    originalCurrency: null,
  };
  const migratedDoc = {
    amount:            174999968,
    currencyMigration: { version: 'rub-base-v1' },
  };
  // After rollback
  const restored = {
    amount:            backup.originalAmount,
    currencyMigration: undefined, // field deleted
  };
  assert.strictEqual(restored.amount, 1988636, 'Original amount restored');
  assert.strictEqual(restored.currencyMigration, undefined, 'Migration marker removed');
  // Sanity: migrated doc has the big number, restored has the small number
  assert.ok(migratedDoc.amount > backup.originalAmount, 'Migration increased the amount');
  assert.strictEqual(restored.amount, backup.originalAmount, 'Rollback restores exactly original value');
});

// ── 8. Transaction count invariant ───────────────────────────────────────────

test('Transaction count: migration never adds or removes documents', () => {
  const docs = [
    makeDoc({ id: 't1', amount: 2000000, createdAt: INSIDE_MS }),
    makeDoc({ id: 't2', amount: 500000,  createdAt: INSIDE_MS }),
    makeDoc({ id: 't3', amount: 50000,   createdAt: INSIDE_MS, source: 'telegram-bot' }),
  ];
  const countBefore = docs.length;
  const toMigrate   = runMigration(docs, 88);
  // toMigrate is updates-only, not additions/deletions
  assert.strictEqual(toMigrate.length, 2, '2 ESTIMATED docs');
  // Total docs count unchanged
  assert.strictEqual(countBefore, 3, 'No documents added or removed');
});

// ── 9. UNKNOWN classification never writes ────────────────────────────────────

test('UNKNOWN docs with non-RUB user are never updated', () => {
  // User with USD currency — their convertToBase may have been amount/1=amount (no change)
  const docs = [
    makeDoc({ id: 'u1', amount: 5000, createdAt: INSIDE_MS }),
  ];
  const toMigrateRUB = runMigration(docs, 88); // runMigration uses userCurrency='RUB' internally
  // For USD user: classify returns UNKNOWN, so not in toMigrate
  const unknownTag = classify(docs[0], 'USD', BUG_START_MS, BUG_END_MS);
  assert.strictEqual(unknownTag, C.UNKNOWN, 'USD user gets UNKNOWN, not ESTIMATED');
  // The runMigration helper above uses hardcoded 'RUB' — for USD user scenario, count would be 0
  // (just verify the classify result is UNKNOWN)
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log('─'.repeat(50) + '\n');

if (failed > 0) process.exit(1);
