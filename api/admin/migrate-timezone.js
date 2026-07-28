'use strict';

// One-shot migration: sets default timezone on users that don't have one.
// GET /api/admin/migrate-timezone?secret=<CRON_SECRET>

const { db, admin } = require('../_lib/firebaseAdmin');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerOk = req.headers.authorization === `Bearer ${secret}`;
    const queryOk  = req.query?.secret === secret;
    if (!headerOk && !queryOk) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const DEFAULT_TZ = 'Europe/Warsaw';
  let updated = 0;
  let skipped = 0;

  try {
    const snap = await db.collection('users').get();

    // Batch updates: Firestore allows max 500 ops per batch
    const BATCH_SIZE = 400;
    let batch = db.batch();
    let batchCount = 0;

    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.timezone) { skipped++; continue; }

      batch.set(doc.ref, {
        timezone:              DEFAULT_TZ,
        timezoneConfidence:    'default',
        timezoneInferredFrom:  null,
      }, { merge: true });

      updated++;
      batchCount++;

      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch      = db.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) await batch.commit();

    res.status(200).json({ ok: true, updated, skipped, total: snap.size });
  } catch (err) {
    console.error('[migrate-timezone] fatal:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
