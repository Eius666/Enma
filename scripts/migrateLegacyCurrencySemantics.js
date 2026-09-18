#!/usr/bin/env node
'use strict';

/**
 * ENMA — Legacy Currency SEMANTIC Migration  (legacy-semantics-v1)
 *
 * "Migration A" from the currency-architecture report — lossless metadata
 * backfill. It adds the correct `currency` field to legacy transactions
 * based on PROVEN historical write-path semantics (see
 * api/_lib/finance/resolveLegacyCurrency.js for the full evidence trail).
 *
 * It NEVER changes `amount`. This is the opposite of, and safer than,
 * scripts/migrateLegacyCurrency.js ("Migration B"), which multiplies amount
 * by an *approximate* historical FX rate to reconstruct a guessed original
 * RUB nominal value — a lossy operation. Migration A should run FIRST (or
 * instead of) Migration B; the two are intentionally kept separate per the
 * report's "don't mix semantic tagging with amount reconstruction" rule.
 *
 * What it does, per legacy transaction (currency field absent):
 *   resolveTransactionCurrency(tx) → { currency, confidence, reason }
 *     confidence 'exact' or 'high'  → write { currency, currencyMigration }
 *     confidence 'unknown'          → SKIP, do not guess (left for manual review)
 *
 * Usage
 * ─────
 *   node scripts/migrateLegacyCurrencySemantics.js [options]
 *
 *   --dry-run               (DEFAULT) Print report, write nothing.
 *   --apply                 Actually write to Firestore. Requires --uid or --all-users.
 *   --rollback              Restore from backup. Requires --uid or --all-users.
 *   --uid=<uid>             Scope to one user.
 *   --all-users             Process every user (requires --confirm-production with --apply).
 *   --confirm-production    Safety gate for all-users apply.
 *   --verbose               Print per-transaction classification (no PII).
 */

// ── env bootstrap ─────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const admin = require('firebase-admin');
const { resolveTransactionCurrency } = require('../api/_lib/finance/resolveLegacyCurrency');

// Credentials come from environment only — NEVER a hardcoded path to a
// service-account JSON file. Two supported sources, same as the existing
// production backend (api/_lib/firebaseAdmin.js):
//   FIREBASE_SERVICE_ACCOUNT       — JSON or base64(JSON) string (prod backend's own convention)
//   GOOGLE_APPLICATION_CREDENTIALS — standard Google ADC env var (path is the operator's choice at runtime)
// Returns only the project_id — never logs the rest of the credential.
function initAdmin() {
  if (admin.apps.length) {
    return admin.app().options.credential?.projectId || admin.app().options.projectId || null;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const sa = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    return sa.project_id || null;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    // applicationDefault() doesn't populate admin.app().options.projectId —
    // read project_id from the same file GOOGLE_APPLICATION_CREDENTIALS
    // points to (operator's own path choice), for the safety banner only.
    try {
      const fs = require('fs');
      const keyFile = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
      return keyFile.project_id || null;
    } catch {
      return null;
    }
  }

  throw new Error(
    'Missing credentials: set FIREBASE_SERVICE_ACCOUNT (JSON or base64) or ' +
    'GOOGLE_APPLICATION_CREDENTIALS (path to a key file) in the environment. ' +
    'This script never reads a hardcoded key file path.'
  );
}

// ── constants ─────────────────────────────────────────────────────────────────

const MIGRATION_VERSION = 'legacy-semantics-v1';
const BACKUP_COLLECTION = 'migrationBackups';
const BATCH_SIZE = 450;

const C = {
  SKIP_ALREADY_HAS_CURRENCY: 'SKIP_ALREADY_HAS_CURRENCY',
  SKIP_ALREADY_MIGRATED:     'SKIP_ALREADY_MIGRATED',
  RESOLVED:                  'RESOLVED',   // will write `currency`
  UNKNOWN:                   'UNKNOWN',    // left untouched — never guessed
};

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: true, apply: false, rollback: false,
    uid: null, allUsers: false, confirmProduction: false, verbose: false,
  };
  for (const arg of args) {
    if (arg === '--dry-run')                opts.dryRun = true;
    else if (arg === '--apply')            { opts.dryRun = false; opts.apply = true; }
    else if (arg === '--rollback')           opts.rollback = true;
    else if (arg === '--all-users')          opts.allUsers = true;
    else if (arg === '--confirm-production') opts.confirmProduction = true;
    else if (arg === '--verbose')            opts.verbose = true;
    else if (arg.startsWith('--uid='))       opts.uid = arg.slice(6);
  }
  return opts;
}

// ── user resolution ───────────────────────────────────────────────────────────

async function resolveUids(db, opts) {
  if (opts.uid) return [opts.uid];
  if (opts.allUsers) {
    const snap = await db.collection('users').select().get();
    return snap.docs.map(d => d.id);
  }
  throw new Error('Specify --uid=<uid> or --all-users');
}

// ── scan one user ─────────────────────────────────────────────────────────────

async function scanUser(db, uid, opts) {
  const snap = await db.collection('transactions').where('userId', '==', uid).get();

  const counts = {
    [C.SKIP_ALREADY_HAS_CURRENCY]: 0,
    [C.SKIP_ALREADY_MIGRATED]:     0,
    [C.RESOLVED]:                  0,
    [C.UNKNOWN]:                   0,
  };
  const toMigrate = []; // { id, ref, resolvedCurrency, confidence, reason }

  for (const doc of snap.docs) {
    const d = doc.data();
    let tag;

    if (d.currencyMigration?.version === MIGRATION_VERSION) {
      tag = C.SKIP_ALREADY_MIGRATED;
    } else if (d.currency) {
      tag = C.SKIP_ALREADY_HAS_CURRENCY;
    } else {
      const resolved = resolveTransactionCurrency(d);
      if (resolved.currency === null) {
        tag = C.UNKNOWN;
      } else {
        tag = C.RESOLVED;
        toMigrate.push({
          id: doc.id, ref: doc.ref,
          resolvedCurrency: resolved.currency,
          confidence: resolved.confidence,
          reason: resolved.reason,
        });
      }
    }

    counts[tag]++;

    if (opts.verbose) {
      const dateStr = (d.date || '').slice(0, 10) || 'unknown';
      console.log(`  [${tag}] id=${doc.id} date=${dateStr} type=${d.type || '?'} source=${d.source || 'none'}`);
    }
  }

  return { uid, txTotal: snap.size, counts, toMigrate };
}

// ── backup ────────────────────────────────────────────────────────────────────

async function backupBatch(db, uid, docs) {
  const migRef = db.collection(BACKUP_COLLECTION).doc(MIGRATION_VERSION).collection('transactions');

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { id, resolvedCurrency, confidence, reason } of chunk) {
      batch.set(migRef.doc(id), {
        transactionId:    id,
        userId:           uid,
        // Explicit, self-contained pre-migration state — every field a
        // rollback needs, without relying on the reader knowing this
        // migration's own selection criteria: only currency-less docs were
        // ever selected, so previousCurrency is always null, made explicit
        // here rather than left implicit.
        previousCurrency: null,
        // What this migration is ABOUT to write, recorded for audit —
        // amount is deliberately absent: this migration never touches it.
        newCurrency:      resolvedCurrency,
        confidence,
        reason,
        backedUpAt:       admin.firestore.FieldValue.serverTimestamp(),
        migrationVersion: MIGRATION_VERSION,
      });
    }
    await batch.commit();
    console.log(`  Backed up ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length} docs`);
  }
}

// ── apply migration ───────────────────────────────────────────────────────────

async function applyMigration(db, toMigrate) {
  const errors = [];

  for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
    const chunk = toMigrate.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const { id, ref, resolvedCurrency, confidence, reason } of chunk) {
      try {
        // NEVER touches `amount` — lossless, semantic-only backfill.
        batch.update(ref, {
          currency: resolvedCurrency,
          currencyMigration: {
            version:    MIGRATION_VERSION,
            migratedAt: new Date().toISOString(),
            method:     'storage_semantics',
            confidence,
            reason,
          },
        });
      } catch (err) {
        errors.push({ id, err: err.message });
      }
    }

    try {
      await batch.commit();
      console.log(`  Applied ${Math.min(i + BATCH_SIZE, toMigrate.length)}/${toMigrate.length} updates`);
    } catch (err) {
      for (const { id } of chunk) errors.push({ id, err: err.message });
      console.error(`  Batch commit failed: ${err.message}`);
    }
  }

  return errors;
}

// ── rollback one user ─────────────────────────────────────────────────────────

async function rollbackUser(db, uid) {
  const backupSnap = await db.collection(BACKUP_COLLECTION).doc(MIGRATION_VERSION)
    .collection('transactions')
    .where('userId', '==', uid)
    .get();

  if (backupSnap.empty) {
    console.log(`  No backups found for uid=${uid}`);
    return { restored: 0, errors: [] };
  }

  const errors = [];
  let restored = 0;

  for (let i = 0; i < backupSnap.docs.length; i += BATCH_SIZE) {
    const chunk = backupSnap.docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const backupDoc of chunk) {
      const b = backupDoc.data();
      const txRef = db.collection('transactions').doc(b.transactionId);
      try {
        // Restores the pre-migration state, from the backup's own explicit
        // previousCurrency field (never assumed) — null means the field was
        // absent before this migration touched it (the only case this
        // migration ever writes), so it's deleted rather than set to null.
        batch.update(txRef, {
          currency:          b.previousCurrency === null || b.previousCurrency === undefined
            ? admin.firestore.FieldValue.delete()
            : b.previousCurrency,
          currencyMigration: admin.firestore.FieldValue.delete(),
        });
      } catch (err) {
        errors.push({ id: b.transactionId, err: err.message });
      }
    }

    try {
      await batch.commit();
      restored += chunk.length;
      console.log(`  Restored ${restored}/${backupSnap.size} docs`);
    } catch (err) {
      for (const d of chunk) errors.push({ id: d.data().transactionId, err: err.message });
      console.error(`  Batch rollback failed: ${err.message}`);
    }
  }

  return { restored, errors };
}

// ── print report ──────────────────────────────────────────────────────────────

function fmtCount(label, n) {
  return `  ${label.padEnd(30)} ${String(n).padStart(8)}`;
}

function printReport(results, mode) {
  const sep = '─'.repeat(62);
  console.log('\n' + sep);
  console.log(`  ENMA Legacy Currency SEMANTIC Migration — ${mode.toUpperCase()}`);
  console.log(`  Version: ${MIGRATION_VERSION} (amount NEVER modified)`);
  console.log(sep);

  let totalTx = 0, totalResolved = 0, totalSkipped = 0, totalUnknown = 0, totalErrors = 0;

  for (const r of results) {
    const resolved = r.counts[C.RESOLVED] || 0;
    const skip = (r.counts[C.SKIP_ALREADY_HAS_CURRENCY] || 0) + (r.counts[C.SKIP_ALREADY_MIGRATED] || 0);
    const unk = r.counts[C.UNKNOWN] || 0;

    totalTx += r.txTotal;
    totalResolved += resolved;
    totalSkipped += skip;
    totalUnknown += unk;
    if (r.errors) totalErrors += r.errors.length;

    const uidMasked = `${r.uid.slice(0, 8)}…`;
    console.log(`\n  User ${uidMasked}  transactions=${r.txTotal}`);
    console.log(fmtCount('RESOLVED (will tag currency)', resolved));
    console.log(fmtCount('SKIP_ALREADY_HAS_CURRENCY', r.counts[C.SKIP_ALREADY_HAS_CURRENCY]));
    console.log(fmtCount('SKIP_ALREADY_MIGRATED', r.counts[C.SKIP_ALREADY_MIGRATED]));
    console.log(fmtCount('UNKNOWN (left untouched)', unk));
    if (r.errors?.length) console.log(fmtCount('ERRORS', r.errors.length));

    if (resolved > 0 && mode === 'dry-run') {
      const byCurrency = {};
      for (const t of r.toMigrate) byCurrency[t.resolvedCurrency] = (byCurrency[t.resolvedCurrency] || 0) + 1;
      console.log(`    Resolved breakdown: ${Object.entries(byCurrency).map(([c, n]) => `${c}=${n}`).join(', ')}`);

      // Aggregate-only classification by reason — counts, never per-tx detail.
      const byReason = {};
      for (const t of r.toMigrate) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
      console.log(`    By reason: ${Object.entries(byReason).map(([reason, n]) => `${reason}=${n}`).join(', ')}`);
    }
  }

  console.log('\n' + sep);
  console.log(fmtCount('TOTAL transactions scanned', totalTx));
  console.log(fmtCount('TOTAL would tag currency', totalResolved));
  console.log(fmtCount('TOTAL already tagged/migrated', totalSkipped));
  console.log(fmtCount('TOTAL unknown (untouched)', totalUnknown));
  if (mode !== 'dry-run') console.log(fmtCount('TOTAL errors', totalErrors));
  console.log(sep);

  if (mode === 'dry-run' && totalResolved > 0) {
    console.log('\n  ⚠️  DRY RUN — nothing was written.');
    console.log(`  To apply for one user: --apply --uid=<uid>`);
    console.log(`  To apply all users:    --apply --all-users --confirm-production`);
  }
  if (totalUnknown > 0) {
    console.log(`\n  ℹ️  ${totalUnknown} records have genuinely unresolvable currency and were left untouched.`);
    console.log('     These are almost certainly the ~71min post-fix gap (see report) or malformed docs.');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.apply && opts.allUsers && !opts.confirmProduction) {
    console.error('ERROR: --apply --all-users requires --confirm-production for safety.');
    process.exit(1);
  }
  if (opts.apply && !opts.uid && !opts.allUsers) {
    console.error('ERROR: --apply requires --uid=<uid> or --all-users.');
    process.exit(1);
  }
  if (opts.rollback && !opts.uid && !opts.allUsers) {
    console.error('ERROR: --rollback requires --uid=<uid> or --all-users.');
    process.exit(1);
  }

  const projectId = initAdmin();
  const db = admin.firestore();

  const uids = await resolveUids(db, opts);

  // ── Safety-check banner — printed BEFORE any Firestore scan/write. ─────────
  // No private data: no private_key/client_email, no individual transaction
  // amounts. Full UID is intentionally shown (not masked) here so the
  // operator can visually confirm it matches the intended TEST_UID before
  // anything runs — this is the one deliberate checkpoint of the operation.
  const runMode = opts.rollback ? 'ROLLBACK' : (opts.dryRun ? 'DRY RUN' : 'APPLY');
  console.log('\n' + '═'.repeat(62));
  console.log('  ENMA Migration A — Safety Check');
  console.log('═'.repeat(62));
  console.log(`  Firebase project : ${projectId || '(unknown — verify credential source)'}`);
  console.log(`  Mode             : ${runMode}`);
  console.log(`  Scope            : ${opts.allUsers ? 'ALL USERS' : `uid=${uids[0] || '(none)'}`}`);
  console.log(`  User count       : ${uids.length}`);
  console.log('═'.repeat(62));

  if (runMode === 'APPLY' && !opts.uid && !opts.allUsers) {
    console.error('ERROR: refusing to proceed — APPLY requires an explicit scope.');
    process.exit(1);
  }

  console.log(`\nProcessing ${uids.length} user(s)…`);

  if (opts.rollback) {
    const results = [];
    for (const uid of uids) {
      console.log(`\nRollback uid=${uid.slice(0, 8)}…`);
      const r = await rollbackUser(db, uid);
      results.push({ uid, ...r });
    }
    console.log('\n── Rollback complete ──');
    for (const r of results) {
      console.log(`  uid=${r.uid.slice(0, 8)}… restored=${r.restored} errors=${r.errors.length}`);
    }
    process.exit(0);
  }

  const results = [];
  for (const uid of uids) {
    const r = await scanUser(db, uid, opts);
    results.push(r);
  }

  // Explicit safety-check line — candidate count only, no amounts, no per-tx detail.
  const totalCandidates = results.reduce((s, r) => s + r.toMigrate.length, 0);
  const totalUnknown    = results.reduce((s, r) => s + (r.counts[C.UNKNOWN] || 0), 0);
  console.log(`\nCandidates found: ${totalCandidates}   UNKNOWN (left untouched): ${totalUnknown}`);

  const mode = opts.dryRun ? 'dry-run' : 'apply';
  printReport(results, mode);

  if (opts.apply) {
    for (const r of results) {
      if (r.toMigrate.length === 0) {
        console.log(`\nuid=${r.uid.slice(0, 8)}… → nothing to migrate`);
        continue;
      }
      console.log(`\nuid=${r.uid.slice(0, 8)}…`);
      console.log(`  Step 1/2: backing up ${r.toMigrate.length} docs…`);
      await backupBatch(db, r.uid, r.toMigrate);

      console.log(`  Step 2/2: applying ${r.toMigrate.length} updates…`);
      const errors = await applyMigration(db, r.toMigrate);
      r.errors = errors;

      console.log(errors.length === 0
        ? `  ✅ Migration complete for uid=${r.uid.slice(0, 8)}…`
        : `  ❌ ${errors.length} errors for uid=${r.uid.slice(0, 8)}…`);
    }

    printReport(results, 'apply');
    console.log('\nPost-migration: re-run proactive detectors to refresh stale insight events.');
    console.log(`Rollback command: node scripts/migrateLegacyCurrencySemantics.js --rollback --uid=<uid>`);
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
