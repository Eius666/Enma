#!/usr/bin/env node
'use strict';

// ── Legacy transactions → schemaVersion 2 ────────────────────────────────────
//
// Gives every legacy transaction (no locked rubAmount) the v2 money fields:
//   schemaVersion: 2, currency, rubAmount, fx
// WITHOUT touching amount, date, description, category, bank or anything else.
//
//   currency   → resolveTransactionCurrency (proven write-path semantics; a
//                transaction whose currency can't be proven is SKIPPED and
//                reported — never guessed)
//   RUB        → rubAmount = amount, fx = null
//   foreign    → rubAmount = amount × CBR OFFICIAL rate for the transaction's
//                own day (cbr-xml-daily archive), fx.source =
//                'official_historical'. NOT today's rate: history is priced
//                once, at its date, and never again.
//
// Safety:
//   • DRY-RUN by default — prints a plan, writes nothing.
//   • --apply needs --confirm-production and exactly ONE scope: --uid <uid> or
//     --all-users.
//   • Every doc is backed up (full copy) to
//       migration_backups/legacy_to_v2/runs/<runId>/transactions/<txId>
//     in the SAME batch as its update, and updated with a lastUpdateTime
//     precondition (a doc changed since it was read is skipped, not clobbered).
//   • Idempotent: v2 docs are ignored, re-running does nothing.
//   • --rollback --run <runId> restores the backed-up docs exactly.
//
// Credentials: GOOGLE_APPLICATION_CREDENTIALS (env only). Nothing is printed
// that contains descriptions or credentials.

const path = require('path');
const admin = require('firebase-admin');
const { resolveTransactionCurrency } = require(path.join(__dirname, '../api/_lib/finance/resolveLegacyCurrency'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const APPLY = flag('--apply');
const ROLLBACK = flag('--rollback');
const ALL = flag('--all-users');
const UID = val('--uid');
const RUN_ID = val('--run');
const LIMIT = val('--limit') ? Number(val('--limit')) : null;
const CONFIRM = flag('--confirm-production');
// --exclude <txId>[,<txId>...] : leave these documents legacy (e.g. outliers awaiting review)
const EXCLUDE = new Set((val('--exclude') || '').split(',').map(x => x.trim()).filter(Boolean));

const BACKUP_ROOT = ['migration_backups', 'legacy_to_v2'];
const BATCH = 200; // 2 writes per doc → 400 ops, under the 500 limit

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }

if (ROLLBACK && !RUN_ID) die('--rollback needs --run <runId>');
if (APPLY && ROLLBACK) die('use either --apply or --rollback');
if ((APPLY || ROLLBACK) && !CONFIRM) die('--apply/--rollback need --confirm-production');
if (APPLY && !(ALL !== !!UID)) die('--apply needs exactly one of --uid <uid> | --all-users');
if (!ROLLBACK && !ALL && !UID) die('scope required: --uid <uid> | --all-users (dry-run is fine)');

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: 'enma-4ea29' });
const db = admin.firestore();

// ── CBR archive rates (per day, cached; steps back over non-publication days) ─

const rateCache = new Map();

async function fetchDay(dayStr) {
  const [y, m, d] = dayStr.split('-');
  const resp = await fetch(`https://www.cbr-xml-daily.ru/archive/${y}/${m}/${d}/daily_json.js`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`CBR archive HTTP ${resp.status} for ${dayStr}`);
  return resp.json();
}

async function cbrRate(currency, dayStr) {
  const key = `${currency}:${dayStr}`;
  if (rateCache.has(key)) return rateCache.get(key);
  let cur = dayStr, result = null;
  for (let i = 0; i < 10 && !result; i++) {
    const data = await fetchDay(cur);
    const v = data && data.Valute && data.Valute[currency];
    if (v && v.Value > 0 && v.Nominal > 0) {
      result = { rateToRub: Math.round((v.Value / v.Nominal) * 10000) / 10000, rateDate: String(data.Date).slice(0, 10) };
    } else {
      const dt = new Date(`${cur}T00:00:00Z`); dt.setUTCDate(dt.getUTCDate() - 1);
      cur = dt.toISOString().slice(0, 10);
    }
  }
  rateCache.set(key, result);
  return result;
}

const round2 = (n) => Math.round(n * 100) / 100;

function txDay(t) {
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.date)) return t.date.slice(0, 10);
  const ms = t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : null;
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
}

// ── Plan one transaction ─────────────────────────────────────────────────────

async function plan(doc) {
  const t = doc.data();
  if (t.schemaVersion === 2 && Number.isFinite(t.rubAmount)) return { skip: 'already_v2' };
  if (!['income', 'expense'].includes(t.type)) return { skip: `non_budget_type:${t.type}` };
  if (typeof t.amount !== 'number' || !Number.isFinite(t.amount) || t.amount <= 0) return { skip: 'bad_amount' };

  const r = resolveTransactionCurrency(t);
  if (!r.currency) return { skip: `unresolved:${r.reason}` };

  const update = { schemaVersion: 2, currency: r.currency, migration: 'legacy_to_v2' };
  if (r.currency === 'RUB') {
    update.rubAmount = round2(t.amount);
    update.fx = null;
    return { update, currency: r.currency, confidence: r.confidence, rubAmount: update.rubAmount };
  }

  const day = txDay(t);
  if (!day) return { skip: 'no_date_for_rate' };
  const rate = await cbrRate(r.currency, day);
  if (!rate) return { skip: `no_cbr_rate:${r.currency}` };
  update.rubAmount = round2(t.amount * rate.rateToRub);
  update.fx = {
    rateToRub: rate.rateToRub,
    source: 'official_historical',
    provider: 'cbr_archive',
    method: 'cbr_daily_archive',
    rateSide: 'mid',
    rateDate: rate.rateDate,
    requestedDate: day,
    rateMatchesRequestedDate: rate.rateDate === day,
    sampleSize: 1,
    migrated: true,
  };
  return { update, currency: r.currency, confidence: r.confidence, rubAmount: update.rubAmount, rate: rate.rateToRub };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function loadDocs() {
  let q = db.collection('transactions');
  if (UID) q = q.where('userId', '==', UID);
  const snap = await q.get();
  return snap.docs;
}

async function runMigration() {
  const docs = await loadDocs();
  const plans = [];
  const skips = {};
  for (const d of docs) {
    if (EXCLUDE.has(d.id)) { skips.excluded_by_flag = (skips.excluded_by_flag || 0) + 1; continue; }
    const p = await plan(d);
    if (p.skip) { if (p.skip !== 'already_v2') skips[p.skip] = (skips[p.skip] || 0) + 1; continue; }
    plans.push({ doc: d, ...p });
    if (LIMIT && plans.length >= LIMIT) break;
  }

  // Summary (aggregate only — no descriptions)
  const byClass = {}, perUser = {};
  for (const p of plans) {
    const k = `${p.currency}|${p.confidence}`;
    byClass[k] = (byClass[k] || 0) + 1;
    const u = (perUser[p.doc.data().userId] ||= { n: 0, incomeRub: 0, expenseRub: 0 });
    u.n++;
    if (p.doc.data().type === 'income') u.incomeRub += p.rubAmount; else u.expenseRub += p.rubAmount;
  }
  console.log(JSON.stringify({
    mode: APPLY ? 'APPLY' : 'DRY-RUN',
    scope: UID ? `uid:${UID.slice(0, 6)}…` : 'all-users',
    transactionsScanned: docs.length,
    toMigrate: plans.length,
    classes: byClass,
    skipped: skips,
    usersAffected: Object.keys(perUser).length,
    totals: { incomeRub: round2(Object.values(perUser).reduce((s, u) => s + u.incomeRub, 0)), expenseRub: round2(Object.values(perUser).reduce((s, u) => s + u.expenseRub, 0)) },
    ratesUsed: [...rateCache.entries()].map(([k, v]) => `${k}=${v && v.rateToRub}`).slice(0, 60),
  }, null, 1));

  if (!APPLY) { console.log('\nDRY-RUN: nothing written.'); return; }
  if (!plans.length) { console.log('Nothing to migrate.'); return; }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runRef = db.collection(BACKUP_ROOT[0]).doc(BACKUP_ROOT[1]).collection('runs').doc(runId);
  await runRef.set({ startedAt: admin.firestore.FieldValue.serverTimestamp(), scope: UID ? 'uid' : 'all-users', planned: plans.length });

  let done = 0, failed = 0;
  for (let i = 0; i < plans.length; i += BATCH) {
    const chunk = plans.slice(i, i + BATCH);
    const batch = db.batch();
    for (const p of chunk) {
      batch.set(runRef.collection('transactions').doc(p.doc.id), {
        originalPath: p.doc.ref.path,
        original: p.doc.data(),
        backedUpAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.update(p.doc.ref, { ...p.update, migratedAt: admin.firestore.FieldValue.serverTimestamp() }, { lastUpdateTime: p.doc.updateTime });
    }
    try { await batch.commit(); done += chunk.length; }
    catch (e) { failed += chunk.length; console.error(`batch ${i / BATCH} failed: ${e.code || e.message}`); }
  }
  await runRef.set({ finishedAt: admin.firestore.FieldValue.serverTimestamp(), migrated: done, failed }, { merge: true });
  console.log(`\nAPPLIED runId=${runId} migrated=${done} failed=${failed}`);
  console.log(`Rollback: node scripts/migrateLegacyToV2.js --rollback --run ${runId} --confirm-production`);
}

async function runRollback() {
  const runRef = db.collection(BACKUP_ROOT[0]).doc(BACKUP_ROOT[1]).collection('runs').doc(RUN_ID);
  const snap = await runRef.collection('transactions').get();
  if (snap.empty) die(`no backups for run ${RUN_ID}`);
  console.log(`Restoring ${snap.size} documents from run ${RUN_ID}`);
  let restored = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const b of snap.docs.slice(i, i + 400)) {
      batch.set(db.doc(b.data().originalPath), b.data().original); // exact original (replaces the migrated doc)
      restored++;
    }
    await batch.commit();
  }
  console.log(`ROLLED BACK ${restored} documents.`);
}

(ROLLBACK ? runRollback() : runMigration()).catch((e) => { console.error('FAILED:', e.code || e.message); process.exit(1); });
