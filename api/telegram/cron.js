const { admin, db } = require('../_lib/firebaseAdmin');
const { validateRequest } = require('../_lib/auth');

const TELEGRAM_API = 'https://api.telegram.org';

// Telegram limits: 30 msg/sec globally, 1 msg/sec per chat.
// We serialize sends and track the last send timestamp per chatId.
const lastSentAt = new Map();
const GLOBAL_INTERVAL_MS = 50;   // 20 msgs/sec — well under the 30/sec global cap
const PER_CHAT_INTERVAL_MS = 1100; // 1.1 sec between messages to the same chat

let lastGlobalSend = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const throttledSend = async (token, chatId, text) => {
  const now = Date.now();
  const globalWait = Math.max(0, lastGlobalSend + GLOBAL_INTERVAL_MS - now);
  const perChatWait = Math.max(0, (lastSentAt.get(chatId) ?? 0) + PER_CHAT_INTERVAL_MS - now);
  const wait = Math.max(globalWait, perChatWait);
  if (wait > 0) await sleep(wait);

  const sendTime = Date.now();
  lastGlobalSend = sendTime;
  lastSentAt.set(chatId, sendTime);

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload.ok !== false, status: response.status, payload };
};

const sendTelegramMessage = (token, chatId, text) => throttledSend(token, chatId, text);

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  const authResult = validateRequest(req);
  if (!authResult.ok) {
    res.status(authResult.status).json(authResult.body);
    return;
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
