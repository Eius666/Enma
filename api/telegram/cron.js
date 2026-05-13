'use strict';

const { admin, db } = require('../_lib/firebaseAdmin');
const { rateLimit, getClientIp } = require('../_lib/rateLimit');

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

  // --- Rate limiting ---
  const ip = getClientIp(req);
  const limitMax = req.method === 'GET' ? 60 : 20;
  if (!rateLimit(`cron:${ip}`, limitMax, 60 * 1000)) {
    res.status(429).json({ ok: false, description: 'Too many requests' });
    return;
  }

  // --- Cron authentication ---
  // Require a Bearer token matching CRON_SECRET.  If CRON_SECRET is not set
  // the endpoint is unprotected — warn loudly.
  //
  // REMOVED: the `user-agent === 'vercel-cron/1.0'` bypass.  Any HTTP client
  // can forge a User-Agent header; relying on it is a false sense of security.
  // Vercel's built-in cron will happily provide the Authorization header when
  // you include the cron secret in vercel.json's env.
  //
  // REMOVED: secret in query string — secrets in URLs end up in server logs,
  // CDN logs, and browser history.  Use the Authorization header only.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn('[cron] CRON_SECRET is not set — cron endpoint is unprotected!');
  } else {
    const authHeader = req.headers?.authorization ?? '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (bearer !== cronSecret) {
      console.warn('[cron] Unauthorized cron attempt');
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
