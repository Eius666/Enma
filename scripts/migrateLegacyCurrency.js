#!/usr/bin/env node
'use strict';

/**
 * ENMA — Legacy Currency Migration  (rub-base-v1)
 *
 * Background
 * ──────────
 * Between 2026-01-15 and 2026-09-18 the frontend stored transaction amounts
 * after dividing the user-entered RUB value by the live USD/RUB exchange rate
 * (BASE_CURRENCY = 'USD'). Example: 175 000 000 ₽ / 88 ≈ 1 988 636 stored.
 *
 * After 2026-09-18 BASE_CURRENCY = 'RUB', amounts are stored as-is.
 *
 * Bug window
 * ──────────
 * BUG_START_ISO = "2026-01-15T14:36:25Z"   (commit 0a11ceb)
 * BUG_END_ISO   = "2026-09-18T09:12:56Z"   (commit cfb457e deployed)
 *
 * Affected collection
 * ───────────────────
 * transactions  →  field `amount` only
 *   SAFE:      source == 'telegram-bot'   (Telegram never used convertToBase)
 *   SAFE:      source == 'ai-chat'        (Web AI chat never used convertToBase)
 *   AFFECTED:  source absent (null/undefined)  →  Web UI form (FinanceEditor/FinanceWorkspace)
 *
 * goals, debts, budgets — NOT affected (goals only created from Telegram bot).
 *
 * Classification
 * ──────────────
 * SKIP_ALREADY_MIGRATED   — currencyMigration.version == 'rub-base-v1'
 * SKIP_HAS_SOURCE         — source field present ('telegram-bot' or 'ai-chat')
 * SKIP_OUTSIDE_WINDOW     — createdAt outside bug window
 * ESTIMATED               — within window, no source, user.currency == 'RUB'
 *                           amount corrected as: Math.round(amount * estimatedRate)
 *                           NOTE: exact historical rate was NOT stored; 88.0 is the
 *                           average USD/RUB rate for the bug window (Jan-Sep 2026)
 * UNKNOWN                 — within window, no source, user.currency != 'RUB'
 *                           (user explicitly chose another display currency —
 *                           their convertToBase may have been correct for them)
 *
 * Usage
 * ─────
 *   node scripts/migrateLegacyCurrency.js [options]
 *
 *   --dry-run               (DEFAULT) Print report, write nothing.
 *   --apply                 Actually write to Firestore. Requires --uid or --all-users.
 *   --rollback              Restore from backup. Requires --uid or --all-users.
 *   --uid=<uid>             Scope to one user.
 *   --all-users             Process every user (requires --confirm-production with --apply).
 *   --confirm-production    Safety gate for all-users apply.
 *   --rate=<number>         Override estimated exchange rate (default: 88.0).
 *   --min-date=<ISO>        Override BUG_START (ISO string).
 *   --max-date=<ISO>        Override BUG_END (ISO string).
 *   --verbose               Print per-transaction classification (no PII).
 */

// ── env bootstrap ─────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  const sa = raw.trim().startsWith('{') ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

// ── constants ─────────────────────────────────────────────────────────────────

const MIGRATION_VERSION = 'rub-base-v1';
const BACKUP_COLLECTION = 'migrationBackups';

// Bug window (UTC milliseconds)
const DEFAULT_BUG_START_ISO = '2026-01-15T14:36:25Z';
const DEFAULT_BUG_END_ISO   = '2026-09-18T09:12:56Z';
const DEFAULT_ESTIMATED_RATE = 88.0;

// Firestore batch size limit
const BATCH_SIZE = 450;

// Classification tags
const C = {
  SKIP_ALREADY_MIGRATED: 'SKIP_ALREADY_MIGRATED',
  SKIP_HAS_SOURCE:       'SKIP_HAS_SOURCE',
  SKIP_OUTSIDE_WINDOW:   'SKIP_OUTSIDE_WINDOW',
  ESTIMATED:             'ESTIMATED',
  UNKNOWN:               'UNKNOWN',
};

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun:             true,
    apply:              false,
    rollback:           false,
    uid:                null,
    allUsers:           false,
    confirmProduction:  false,
    rate:               DEFAULT_ESTIMATED_RATE,
    minDate:            DEFAULT_BUG_START_ISO,
    maxDate:            DEFAULT_BUG_END_ISO,
    verbose:            false,
  };

  for (const arg of args) {
    if (arg === '--dry-run')             opts.dryRun            = true;
    else if (arg === '--apply')        { opts.dryRun = false; opts.apply = true; }
    else if (arg === '--rollback')       opts.rollback          = true;
    else if (arg === '--all-users')      opts.allUsers          = true;
    else if (arg === '--confirm-production') opts.confirmProduction = true;
    else if (arg === '--verbose')        opts.verbose           = true;
    else if (arg.startsWith('--uid='))  opts.uid               = arg.slice(6);
    else if (arg.startsWith('--rate=')) opts.rate              = parseFloat(arg.slice(7));
    else if (arg.startsWith('--min-date=')) opts.minDate       = arg.slice(11);
    else if (arg.startsWith('--max-date=')) opts.maxDate       = arg.slice(11);
  }

  return opts;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function msOf(isoOrTimestamp) {
  if (!isoOrTimestamp) return null;
  if (typeof isoOrTimestamp === 'number') return isoOrTimestamp;
  if (isoOrTimestamp._seconds !== undefined) return isoOrTimestamp._seconds * 1000;
  if (typeof isoOrTimestamp.toMillis === 'function') return isoOrTimestamp.toMillis();
  return new Date(isoOrTimestamp).getTime();
}

function fmtCount(label, n) {
  return `  ${label.padEnd(30)} ${String(n).padStart(8)}`;
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

// ── classify one transaction ──────────────────────────────────────────────────

function classify(doc, userCurrency, bugStartMs, bugEndMs) {
  const d = doc.data();

  // Already migrated
  if (d.currencyMigration?.version === MIGRATION_VERSION) {
    return C.SKIP_ALREADY_MIGRATED;
  }

  // Source field means safe origin
  if (d.source) {
    return C.SKIP_HAS_SOURCE;
  }

  // Outside bug window (use createdAt; fall back to date string)
  const ts = msOf(d.createdAt) ?? msOf(d.date);
  if (!ts || ts < bugStartMs || ts >= bugEndMs) {
    return C.SKIP_OUTSIDE_WINDOW;
  }

  // User currency determines if convertToBase could have divided by anything != 1
  // If user currency was USD at the time: rates['USD'] = 1, so amount was stored as-is.
  // We use current user currency as best proxy (most users never changed it).
  if (userCurrency !== 'RUB') {
    return C.UNKNOWN;
  }

  return C.ESTIMATED;
}

// ── scan one user ─────────────────────────────────────────────────────────────

async function scanUser(db, uid, opts, bugStartMs, bugEndMs) {
  const userSnap = await db.collection('users').doc(uid).get();
  const userCurrency = (userSnap.exists ? userSnap.data()?.currency : null) || 'RUB';

  const snap = await db.collection('transactions').where('userId', '==', uid).get();

  const counts = {
    [C.SKIP_ALREADY_MIGRATED]: 0,
    [C.SKIP_HAS_SOURCE]:       0,
    [C.SKIP_OUTSIDE_WINDOW]:   0,
    [C.ESTIMATED]:             0,
    [C.UNKNOWN]:               0,
  };
  const toMigrate = [];  // { id, data, classification, correctedAmount }

  for (const doc of snap.docs) {
    const tag = classify(doc, userCurrency, bugStartMs, bugEndMs);
    counts[tag]++;

    if (tag === C.ESTIMATED) {
      const legacyAmount = doc.data().amount;
      const corrected = Math.round(legacyAmount * opts.rate);
      toMigrate.push({ id: doc.id, ref: doc.ref, data: doc.data(), classification: tag, legacyAmount, correctedAmount: corrected });
    }

    if (opts.verbose) {
      const d = doc.data();
      const ts = msOf(d.createdAt) ?? msOf(d.date);
      const dateStr = ts ? new Date(ts).toISOString().slice(0, 10) : 'unknown';
      // Never log description, category, bank — only classification metadata
      console.log(`  [${tag}] id=${doc.id} date=${dateStr} type=${d.type || '?'} source=${d.source || 'none'}`);
    }
  }

  return { uid, userCurrency, txTotal: snap.size, counts, toMigrate };
}

// ── backup ────────────────────────────────────────────────────────────────────

async function backupBatch(db, uid, docs) {
  const migRef = db.collection(BACKUP_COLLECTION).doc(MIGRATION_VERSION)
    .collection('transactions');

  // Write in BATCH_SIZE chunks
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { id, data } of chunk) {
      const backupRef = migRef.doc(id);
      batch.set(backupRef, {
        transactionId:    id,
        userId:           uid,
        originalAmount:   data.amount,
        originalCurrency: data.currency || null,
        originalFields:   data,
        backedUpAt:       admin.firestore.FieldValue.serverTimestamp(),
        migrationVersion: MIGRATION_VERSION,
      });
    }
    await batch.commit();
    console.log(`  Backed up ${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length} docs`);
  }
}

// ── apply migration ───────────────────────────────────────────────────────────

async function applyMigration(db, uid, toMigrate, rate) {
  const errors = [];

  for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
    const chunk = toMigrate.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const { id, ref, correctedAmount } of chunk) {
      try {
        batch.update(ref, {
          amount: correctedAmount,
          currencyMigration: {
            version:    MIGRATION_VERSION,
            migratedAt: new Date().toISOString(),
            method:     'estimated',
            rate:       rate,
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
      // Batch failed — record all ids in this chunk as errors
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
        // Restore original amount and currency; remove migration marker
        batch.update(txRef, {
          amount:            b.originalAmount,
          currency:          b.originalCurrency ?? admin.firestore.FieldValue.delete(),
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

function printReport(results, opts, mode) {
  const sep = '─'.repeat(62);
  console.log('\n' + sep);
  console.log(`  ENMA Currency Migration Report — ${mode.toUpperCase()}`);
  console.log(`  Version: ${MIGRATION_VERSION}   Rate: ×${opts.rate}`);
  console.log(`  Bug window: ${opts.minDate} → ${opts.maxDate}`);
  console.log(sep);

  let totalTx        = 0;
  let totalEstimated = 0;
  let totalSkipped   = 0;
  let totalUnknown   = 0;
  let totalErrors    = 0;

  for (const r of results) {
    const e = r.counts[C.ESTIMATED] || 0;
    const skip =
      (r.counts[C.SKIP_ALREADY_MIGRATED] || 0) +
      (r.counts[C.SKIP_HAS_SOURCE]       || 0) +
      (r.counts[C.SKIP_OUTSIDE_WINDOW]   || 0);
    const unk = r.counts[C.UNKNOWN] || 0;

    totalTx        += r.txTotal;
    totalEstimated += e;
    totalSkipped   += skip;
    totalUnknown   += unk;
    if (r.errors) totalErrors += r.errors.length;

    // Per-user summary (uid masked to first 8 chars)
    const uidMasked = `${r.uid.slice(0, 8)}…`;
    console.log(`\n  User ${uidMasked}  currency=${r.userCurrency}  transactions=${r.txTotal}`);
    console.log(fmtCount('ESTIMATED (will update)', e));
    console.log(fmtCount('SKIP_ALREADY_MIGRATED', r.counts[C.SKIP_ALREADY_MIGRATED]));
    console.log(fmtCount('SKIP_HAS_SOURCE', r.counts[C.SKIP_HAS_SOURCE]));
    console.log(fmtCount('SKIP_OUTSIDE_WINDOW', r.counts[C.SKIP_OUTSIDE_WINDOW]));
    console.log(fmtCount('UNKNOWN (no change)', unk));
    if (r.errors?.length) {
      console.log(fmtCount('ERRORS', r.errors.length));
    }

    if (e > 0 && mode === 'dry-run') {
      // Show aggregate before/after without revealing individual amounts
      const totalBefore = r.toMigrate.reduce((s, t) => s + t.legacyAmount, 0);
      const totalAfter  = r.toMigrate.reduce((s, t) => s + t.correctedAmount, 0);
      console.log(`    Aggregate: before=${totalBefore.toFixed(2)} → after=${totalAfter.toFixed(0)} RUB`);
    }
  }

  console.log('\n' + sep);
  console.log(fmtCount('TOTAL transactions scanned', totalTx));
  console.log(fmtCount('TOTAL would update', totalEstimated));
  console.log(fmtCount('TOTAL skipped', totalSkipped));
  console.log(fmtCount('TOTAL unknown (no change)', totalUnknown));
  if (mode !== 'dry-run') console.log(fmtCount('TOTAL errors', totalErrors));
  console.log(sep);

  if (mode === 'dry-run' && totalEstimated > 0) {
    console.log('\n  ⚠️  DRY RUN — nothing was written.');
    console.log(`  To apply for one user: --apply --uid=<uid>`);
    console.log(`  To apply all users:    --apply --all-users --confirm-production`);
  }
  if (totalUnknown > 0) {
    console.log(`\n  ℹ️  ${totalUnknown} UNKNOWN records were NOT changed.`);
    console.log('     These belong to users whose display currency was not RUB.');
    console.log('     Review manually if needed.');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Safety gate
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

  if (isNaN(opts.rate) || opts.rate <= 0 || opts.rate > 200) {
    console.error(`ERROR: --rate=${opts.rate} is invalid. Expected a positive FX rate (e.g. 88).`);
    process.exit(1);
  }

  initAdmin();
  const db = admin.firestore();

  const bugStartMs = new Date(opts.minDate).getTime();
  const bugEndMs   = new Date(opts.maxDate).getTime();

  if (isNaN(bugStartMs) || isNaN(bugEndMs)) {
    console.error('ERROR: Invalid --min-date or --max-date');
    process.exit(1);
  }

  const uids = await resolveUids(db, opts);
  console.log(`\nProcessing ${uids.length} user(s)…`);

  // ── ROLLBACK path ──────────────────────────────────────────────────────────
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

  // ── SCAN all users ─────────────────────────────────────────────────────────
  const results = [];
  for (const uid of uids) {
    const r = await scanUser(db, uid, opts, bugStartMs, bugEndMs);
    results.push(r);
  }

  const mode = opts.dryRun ? 'dry-run' : 'apply';
  printReport(results, opts, mode);

  // ── APPLY path ─────────────────────────────────────────────────────────────
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
      const errors = await applyMigration(db, r.uid, r.toMigrate, opts.rate);
      r.errors = errors;

      if (errors.length === 0) {
        console.log(`  ✅ Migration complete for uid=${r.uid.slice(0, 8)}…`);
      } else {
        console.error(`  ❌ ${errors.length} errors for uid=${r.uid.slice(0, 8)}…`);
      }
    }

    printReport(results, opts, 'apply');
    console.log('\nPost-migration: run proactive detectors to refresh stale insight events.');
    console.log(`Rollback command: node scripts/migrateLegacyCurrency.js --rollback --uid=<uid>`);
  }

  await admin.app().delete();
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
