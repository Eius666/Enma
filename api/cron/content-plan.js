'use strict';

// Content planner — runs daily at 06:00 UTC (Vercel cron).
// Also handles the 10:00 reminder check when called with ?type=remind.
//
// Flow:
//   1. Generate 4 post ideas via LLM
//   2. Save each idea to Firestore content_queue (status: 'idea')
//   3. Send each idea to admin with inline approve/regen/skip buttons
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN
//   CONTENT_ADMIN_CHAT_ID  — admin's personal chat ID for moderation
//   OPENROUTER_API_KEY
//   CRON_SECRET

const { db, admin } = require('../_lib/firebaseAdmin');
const { generateIdeas } = require('../_lib/content/generator');
const { sendIdeaToAdmin, tgPost } = require('../_lib/content/adminSender');

const TELEGRAM_API = 'https://api.telegram.org';

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerOk = req.headers.authorization === `Bearer ${secret}`;
  const queryOk  = req.query?.secret === secret;
  return headerOk || queryOk;
}

// ── Reminder mode ─────────────────────────────────────────────────────────────

async function handleRemind(token, adminChatId) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const snap = await db.collection('content_queue')
    .where('status', 'in', ['approved', 'published'])
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(today))
    .limit(1)
    .get();

  if (snap.empty && token && adminChatId) {
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId,
        text: '⏰ Напоминание: сегодня ещё ничего не одобрено.\n\nПосмотри утренние идеи выше ⬆️',
      }),
    });
  }

  return { ok: true, type: 'remind', hasApproved: !snap.empty };
}

// ── Weekly report ─────────────────────────────────────────────────────────────

async function handleWeeklyReport(token, adminChatId) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [publishedSnap, rejectedSnap] = await Promise.all([
    db.collection('content_queue')
      .where('status', '==', 'published')
      .where('publishedAt', '>=', admin.firestore.Timestamp.fromDate(weekAgo))
      .get(),
    db.collection('content_queue')
      .where('status', '==', 'rejected')
      .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(weekAgo))
      .get(),
  ]);

  const published = publishedSnap.size;
  const rejected  = rejectedSnap.size;

  if (token && adminChatId) {
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId,
        text:
          `📊 <b>Итоги недели</b>\n\n` +
          `✅ Опубликовано: ${published}\n` +
          `❌ Отклонено: ${rejected}`,
        parse_mode: 'HTML',
      }),
    });
  }

  return { ok: true, type: 'weekly_report', published, rejected };
}

// ── Main: idea generation ─────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const token      = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.CONTENT_ADMIN_CHAT_ID;
  const type        = req.query?.type;

  if (type === 'remind') {
    const result = await handleRemind(token, adminChatId).catch(err => ({ ok: false, error: err.message }));
    res.status(200).json(result);
    return;
  }

  if (type === 'weekly_report') {
    const result = await handleWeeklyReport(token, adminChatId).catch(err => ({ ok: false, error: err.message }));
    res.status(200).json(result);
    return;
  }

  const now = new Date();

  try {
    const ideas = await generateIdeas(now);

    // Batch-write all ideas to Firestore
    const batch  = db.batch();
    const docIds = [];

    for (const idea of ideas) {
      const ref = db.collection('content_queue').doc();
      docIds.push(ref.id);
      batch.set(ref, {
        idea:              idea.title,
        angle:             idea.angle,
        format:            idea.format || 'single',
        status:            'idea',
        type:              'single',
        text:              null,
        telegramText:      null,
        threadsText:       null,
        imageUrl:          null,
        imagePrompt:       null,
        scheduledAt:       null,
        publishedAt:       null,
        platforms:         { telegram: true, threads: true },
        telegramMessageId: null,
        threadsMediaId:    null,
        adminMessageId:    null,
        adminDraftMessageId: null,
        retryCount:        0,
        createdAt:         admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    await db.collection('content_logs').add({
      event:    'ideas_generated',
      count:    ideas.length,
      docIds,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify admin
    if (token && adminChatId) {
      const dateLabel = now.toLocaleDateString('ru-RU', {
        timeZone: 'UTC', day: 'numeric', month: 'long',
      });
      await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: `📅 <b>Идеи на ${dateLabel}</b> (${ideas.length} шт.)`,
          parse_mode: 'HTML',
        }),
      });

      for (let i = 0; i < ideas.length; i++) {
        try {
          const msg = await sendIdeaToAdmin(token, docIds[i], ideas[i], i + 1, ideas.length);
          await db.collection('content_queue').doc(docIds[i]).update({
            adminMessageId: msg.message_id,
          });
        } catch (err) {
          console.error('[content-plan] send idea error:', err.message);
        }
      }
    }

    res.status(200).json({ ok: true, ideas: ideas.length, docIds });
  } catch (err) {
    console.error('[content-plan] error:', err.message);
    await db.collection('content_logs').add({
      event:     'ideas_error',
      error:     err.message,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  }
};
