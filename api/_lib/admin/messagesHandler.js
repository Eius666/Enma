'use strict';

// Admin broadcast messages — POST /api/ai/adminMessages.
//   { action: 'history' }                        → last 50 broadcasts
//   { text, target: 'all'|'free'|'pro'|'premium'|[uid, …] } → send via the bot
// Built by the api/ai router (see api/ai/[action].js).

const BATCH_SIZE = 30;          // messages sent in parallel
const BATCH_PAUSE_MS = 1000;    // pause between batches (Telegram rate limits)

function createMessagesHandler(ctx) {
  const { db, admin, requireAdmin } = ctx;

  async function broadcastHistory(res) {
    const snap = await db.collection('adminMessages').orderBy('sentAt', 'desc').limit(50).get();
    const msgs = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      sentAt: d.data().sentAt?.toDate?.()?.toISOString?.() || '',
    }));
    return res.status(200).json({ ok: true, messages: msgs });
  }

  // Chat ids of the target audience, de-duplicated.
  async function resolveAudience(target) {
    let chatIds = [];

    if (Array.isArray(target)) {
      const snaps = await Promise.all(target.map(uid => db.collection('users').doc(uid).get()));
      chatIds = snaps
        .filter(s => s.exists)
        .map(s => s.data().chatId || s.data().telegramId)
        .filter(Boolean);
    } else {
      const usersSnap = await db.collection('users').get();
      if (target === 'all') {
        chatIds = usersSnap.docs
          .map(d => d.data().chatId || d.data().telegramId)
          .filter(Boolean);
      } else {
        const subsSnap = await db.collection('subscriptions').where('status', '==', 'active').get();
        const activeSubs = new Map(subsSnap.docs.map(d => [d.id, d.data()]));
        chatIds = usersSnap.docs.filter(d => {
          const sub  = activeSubs.get(d.id);
          const endMs = sub?.endDateMs ?? sub?.expiresAt?.toMillis?.() ?? 0;
          if (endMs && endMs < Date.now()) return target === 'free';
          const plan = sub?.plan || 'free';
          return plan === target;
        }).map(d => d.data().chatId || d.data().telegramId).filter(Boolean);
      }
    }

    // Deduplicate: same Telegram user may have multiple Firestore docs (anon + custom token)
    return [...new Set(chatIds.map(id => String(id)))];
  }

  async function sendToAll(token, chatIds, text) {
    let sent = 0, failed = 0;
    for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
      const chunk = chatIds.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(chunk.map(async chatId => {
        try {
          const r    = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
          });
          const data = await r.json();
          if (data.ok) sent++; else failed++;
        } catch { failed++; }
      }));
      if (i + BATCH_SIZE < chatIds.length) await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
    return { sent, failed };
  }

  async function handleAdminMessages(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body ?? {};

    if (body.action === 'history') return broadcastHistory(res);

    const { text, target = 'all' } = body;
    if (!text) return res.status(400).json({ error: 'text required' });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });

    const chatIds = await resolveAudience(target);
    const { sent, failed } = await sendToAll(token, chatIds, text);

    await db.collection('adminMessages').add({
      text, target: typeof target === 'string' ? target : 'custom',
      total: chatIds.length, sent, failed,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true, total: chatIds.length, sent, failed });
  }

  return { handleAdminMessages };
}

module.exports = { createMessagesHandler };
