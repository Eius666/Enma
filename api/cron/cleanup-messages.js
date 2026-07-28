'use strict';

// Message history cleanup cron.
// Free users:  delete messages older than 30 days
// Pro users:   delete messages older than 90 days
// Run: daily (e.g. 0 3 * * * via cron-job.org)

const { db, admin } = require('../_lib/firebaseAdmin');
const { checkSubscription } = require('../_lib/ai/subscription');

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerOk = req.headers.authorization === `Bearer ${secret}`;
  const queryOk  = req.query?.secret === secret;
  return headerOk || queryOk;
}

const FREE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const PRO_MAX_AGE_MS  = 90 * 24 * 60 * 60 * 1000;  // 90 days
const DELETE_BATCH    = 400;

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let totalDeleted = 0;
  const now = Date.now();

  try {
    // Query messages older than 30 days (most aggressive cut-off)
    const cutoff30 = new Date(now - FREE_MAX_AGE_MS);
    const cutoff90 = new Date(now - PRO_MAX_AGE_MS);

    // We process two passes:
    // Pass 1: delete messages > 90 days for everyone
    // Pass 2: delete messages between 30-90 days for free users only

    // Pass 1 — older than 90 days, delete regardless of plan
    {
      const snap = await db.collection('messages')
        .where('createdAt', '<', admin.firestore.Timestamp.fromDate(cutoff90))
        .limit(500)
        .get();

      let batch = db.batch();
      let n = 0;
      for (const doc of snap.docs) {
        batch.delete(doc.ref);
        n++;
        if (n % DELETE_BATCH === 0) { await batch.commit(); batch = db.batch(); }
      }
      if (n % DELETE_BATCH !== 0) await batch.commit();
      totalDeleted += n;
    }

    // Pass 2 — between 30 and 90 days: only delete for free users
    {
      const snap = await db.collection('messages')
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(cutoff90))
        .where('createdAt', '<',  admin.firestore.Timestamp.fromDate(cutoff30))
        .limit(500)
        .get();

      // Group by userId to batch subscription checks
      const byUser = new Map();
      for (const doc of snap.docs) {
        const uid = doc.data().userId;
        if (!uid) { continue; }
        if (!byUser.has(uid)) byUser.set(uid, []);
        byUser.get(uid).push(doc);
      }

      let batch = db.batch();
      let n = 0;
      for (const [uid, docs] of byUser.entries()) {
        const sub = await checkSubscription(uid).catch(() => ({ active: false }));
        if (sub.active) continue; // pro users: keep 30-90 day messages

        for (const doc of docs) {
          batch.delete(doc.ref);
          n++;
          if (n % DELETE_BATCH === 0) { await batch.commit(); batch = db.batch(); }
        }
      }
      if (n % DELETE_BATCH !== 0) await batch.commit();
      totalDeleted += n;
    }

    res.status(200).json({ ok: true, deleted: totalDeleted });
  } catch (err) {
    console.error('[cleanup-messages] fatal:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
