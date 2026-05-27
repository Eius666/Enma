const { admin, db } = require('../api/_lib/firebaseAdmin');

const isDryRun = process.argv.includes('--dry-run');
const limitArgIndex = process.argv.findIndex(arg => arg === '--limit');
const limitArg = limitArgIndex !== -1 ? Number(process.argv[limitArgIndex + 1]) : null;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_SIZE = 400;

const toDateSafe = (value) => {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (value instanceof Date) return value;
  return null;
};

const shouldUpdate = (dateValue) => typeof dateValue === 'string' && DATE_ONLY_REGEX.test(dateValue);

async function backfillTransactionTimes() {
  console.log(`\n🔧 Backfilling transaction times${isDryRun ? ' (dry run)' : ''}...`);

  let query = db.collection('transactions').where('source', '==', 'telegram-bot');
  if (Number.isFinite(limitArg) && limitArg > 0) {
    query = query.limit(limitArg);
  }

  const snapshot = await query.get();
  if (snapshot.empty) {
    console.log('No matching transactions found.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!shouldUpdate(data.date)) {
      skipped += 1;
      continue;
    }

    const updatedAt = toDateSafe(data.updatedAt) || toDateSafe(data.createdAt);
    if (!updatedAt) {
      skipped += 1;
      continue;
    }

    const nextDate = updatedAt.toISOString();
    if (isDryRun) {
      updated += 1;
      continue;
    }

    batch.update(doc.ref, { date: nextDate });
    updated += 1;
    batchCount += 1;

    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (!isDryRun && batchCount > 0) {
    await batch.commit();
  }

  console.log(`✅ Done. Updated: ${updated}. Skipped: ${skipped}.`);
}

backfillTransactionTimes().catch(error => {
  console.error('❌ Backfill failed:', error);
  process.exit(1);
});
