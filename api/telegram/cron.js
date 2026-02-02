const { admin, db } = require('../_lib/firebaseAdmin');

const TELEGRAM_API = 'https://api.telegram.org';

const sendTelegramMessage = async (token, chatId, text) => {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload.ok !== false, status: response.status, payload };
};

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers?.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const querySecret = typeof req.query?.secret === 'string' ? req.query.secret : '';
    if (bearer !== cronSecret && querySecret !== cronSecret) {
      res.status(401).json({ ok: false, description: 'Unauthorized' });
      return;
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, description: 'Missing TELEGRAM_BOT_TOKEN' });
    return;
  }

  try {
    const now = admin.firestore.Timestamp.fromDate(new Date());
    const snapshot = await db
      .collection('reminders')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', now)
      .orderBy('scheduledAt', 'asc')
      .limit(100)
      .get();

    if (snapshot.empty) {
      res.status(200).json({ ok: true, processed: 0 });
      return;
    }

    const results = [];
    for (const docSnap of snapshot.docs) {
      const docRef = docSnap.ref;
      const claimed = await db.runTransaction(async tx => {
        const latest = await tx.get(docRef);
        if (!latest.exists) return null;
        const data = latest.data();
        if (data.status !== 'pending') return null;
        tx.update(docRef, {
          status: 'sending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return data;
      });

      if (!claimed) continue;
      const text =
        claimed.telegramText ||
        `Reminder: ${claimed.title}${claimed.time ? `\n${claimed.time}` : ''}`;

      const sendResult = await sendTelegramMessage(token, claimed.chatId, text);
      if (sendResult.ok) {
        await docRef.update({
          status: 'sent',
          notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await docRef.update({
          status: 'pending',
          lastError: sendResult.payload?.description ?? 'Telegram send failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      results.push({ id: docRef.id, ok: sendResult.ok, status: sendResult.status });
    }

    res.status(200).json({ ok: true, processed: results.length, results });
  } catch (error) {
    console.error('❌ Cron execution error:', error);
    res.status(500).json({ ok: false, description: 'Cron failed' });
  }
};
