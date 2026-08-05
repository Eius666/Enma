'use strict';

const { db, admin } = require('../_lib/firebaseAdmin');

const TG = 'https://api.telegram.org';

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerOk = req.headers.authorization === `Bearer ${secret}`;
  const queryOk  = req.query?.secret === secret;
  return headerOk || queryOk;
}

async function tgSend(token, chatId, body) {
  return fetch(`${TG}/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, ...body }),
  });
}

function formatTime(isoOrDate, timezone) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone || 'UTC',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate);
  } catch (_) { return ''; }
}

module.exports = async (req, res) => {
  if (!checkAuth(req)) {
    res.status(401).json({ ok: false });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const now   = new Date();
  const TASK_LOOKAHEAD_MS = 15 * 60 * 1000; // warn 15 min before

  let remindersSent = 0;
  let tasksSent     = 0;
  let failed        = 0;

  try {
    // ── 1. Regular reminders ────────────────────────────────────────────────
    const remSnap = await db.collection('reminders').where('sent', '==', false).limit(50).get();
    const dueReminders = remSnap.docs.filter(doc => {
      const r = doc.data();
      return r.triggerAt && new Date(r.triggerAt) <= now;
    });

    await Promise.allSettled(
      dueReminders.map(async (doc) => {
        const r = doc.data();
        const timeLabel = formatTime(r.triggerAt, r.timezone);
        const msgText   = timeLabel
          ? `🔔 Напоминание (${timeLabel}): ${r.text}`
          : `🔔 Напоминание: ${r.text}`;

        const resp = await tgSend(token, r.telegramChatId, { text: msgText });
        if (!resp.ok) throw new Error(`Telegram ${resp.status} for reminder ${doc.id}`);
        await doc.ref.update({ sent: true });
        remindersSent++;
      })
    ).then(results => {
      results.filter(r => r.status === 'rejected').forEach(r => {
        console.error('[reminders] reminder error:', r.reason);
        failed++;
      });
    });

    // ── 2. Proactive task notifications (15 min before scheduledAt) ─────────
    // Single-field filter + in-memory check to avoid composite index
    const taskSnap = await db.collection('tasks')
      .where('reminderSent', '==', false)
      .limit(50)
      .get();

    const dueTasks = taskSnap.docs.filter(doc => {
      const t = doc.data();
      if (!t.scheduledAt) return false;
      if (t.status && !['pending', 'in_progress'].includes(t.status)) return false;
      const at = t.scheduledAt.toDate ? t.scheduledAt.toDate() : new Date(t.scheduledAt);
      return at <= new Date(now.getTime() + TASK_LOOKAHEAD_MS) && at >= now;
    });

    await Promise.allSettled(
      dueTasks.map(async (doc) => {
        const t        = doc.data();
        const chatId   = t.telegramChatId;
        if (!chatId) return;

        const at       = t.scheduledAt.toDate ? t.scheduledAt.toDate() : new Date(t.scheduledAt);
        const tz       = await db.collection('users').doc(t.userId).get()
          .then(u => u.data()?.timezone || 'Europe/Warsaw')
          .catch(() => 'Europe/Warsaw');

        const timeStr  = formatTime(at, tz);
        const minsLeft = Math.round((at - now) / 60000);
        const when     = minsLeft <= 1 ? 'сейчас' : `через ${minsLeft} мин (${timeStr})`;

        const resp = await tgSend(token, chatId, {
          text:         `⏰ <b>${t.title}</b>\n${when}`,
          parse_mode:   'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Выполнить',    callback_data: `task_done_${doc.id}`          },
              { text: '😴 15 мин',       callback_data: `task_snooze15m_${doc.id}`     },
            ], [
              { text: '⏰ 1 час',         callback_data: `task_snooze1h_${doc.id}`      },
              { text: '📅 Завтра',        callback_data: `task_snoozetomorrow_${doc.id}` },
            ]],
          },
        });

        if (!resp.ok) throw new Error(`Telegram ${resp.status} for task ${doc.id}`);
        await doc.ref.update({
          reminderSent: true,
          updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
        });
        tasksSent++;
      })
    ).then(results => {
      results.filter(r => r.status === 'rejected').forEach(r => {
        console.error('[reminders] task error:', r.reason);
        failed++;
      });
    });

    res.status(200).json({ ok: true, remindersSent, tasksSent, failed });
  } catch (err) {
    console.error('[reminders] fatal:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
