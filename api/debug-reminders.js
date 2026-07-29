'use strict';

// Debug endpoint — inspect reminders collection directly.
// GET /api/debug-reminders?secret=<CRON_SECRET>

const { db } = require('./_lib/firebaseAdmin');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerOk = req.headers.authorization === `Bearer ${secret}`;
    const queryOk  = req.query?.secret === secret;
    if (!headerOk && !queryOk) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  try {
    // Last 10 reminders regardless of status, newest first
    const allSnap = await db.collection('reminders')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();

    const now = new Date();

    const docs = allSnap.docs.map(d => {
      const data = d.data();
      const sAt  = data.scheduledAt;
      let scheduledAtIso = null;
      let scheduledAtType = typeof sAt;
      let isDue = false;

      if (sAt && sAt.toDate) {
        scheduledAtIso  = sAt.toDate().toISOString();
        scheduledAtType = 'Firestore Timestamp';
        isDue           = sAt.toDate() <= now;
      } else if (sAt) {
        scheduledAtIso  = String(sAt);
        scheduledAtType = 'string/other';
        isDue           = new Date(sAt) <= now;
      }

      return {
        id:             d.id,
        title:          data.title,
        status:         data.status,
        chatId:         data.chatId,
        userId:         data.userId,
        telegramText:   data.telegramText,
        scheduledAt:    scheduledAtIso,
        scheduledAtType,
        isDue,
        source:         data.source,
        lastError:      data.lastError,
        createdAt:      data.createdAt?.toDate?.()?.toISOString?.() ?? data.createdAt,
      };
    });

    // Count by status
    const byStatus = {};
    for (const d of docs) { byStatus[d.status] = (byStatus[d.status] || 0) + 1; }

    res.status(200).json({
      ok:        true,
      serverNow: now.toISOString(),
      total:     docs.length,
      byStatus,
      docs,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
