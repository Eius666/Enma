'use strict';

const { db } = require('../_lib/firebaseAdmin');

const TELEGRAM_API = 'https://api.telegram.org';

module.exports = async (req, res) => {
  // Auth: cron-job.org sends GET with ?secret=... or Authorization: Bearer ...
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerOk = req.headers.authorization === `Bearer ${secret}`;
    const queryOk  = req.query?.secret === secret;
    if (!headerOk && !queryOk) {
      res.status(401).json({ ok: false });
      return;
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const now   = new Date();

  try {
    // Read all unsent reminders and filter in memory — avoids a composite Firestore index.
    const snap = await db.collection('reminders').where('sent', '==', false).get();
    const due  = snap.docs.filter(doc => {
      const r = doc.data();
      return r.triggerAt && new Date(r.triggerAt) <= now;
    });

    if (!due.length) {
      res.status(200).json({ ok: true, processed: 0 });
      return;
    }

    const results = await Promise.allSettled(
      due.map(async (doc) => {
        const r = doc.data();
        let timeLabel = '';
        if (r.timezone && r.triggerAt) {
          try {
            timeLabel = new Intl.DateTimeFormat('ru-RU', {
              timeZone: r.timezone,
              hour: '2-digit', minute: '2-digit',
              hour12: false,
            }).format(new Date(r.triggerAt));
          } catch (_) {}
        }
        const msgText = timeLabel
          ? `🔔 Напоминание (${timeLabel}): ${r.text}`
          : `🔔 Напоминание: ${r.text}`;
        const resp = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            chat_id: r.telegramChatId,
            text:    msgText,
          }),
        });
        if (!resp.ok) throw new Error(`Telegram ${resp.status} for reminder ${doc.id}`);
        await doc.ref.update({ sent: true });
      })
    );

    const processed = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected');
    failed.forEach(r => console.error('[reminders cron]', r.reason));

    res.status(200).json({ ok: true, processed, failed: failed.length });
  } catch (err) {
    console.error('[reminders cron] fatal:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
