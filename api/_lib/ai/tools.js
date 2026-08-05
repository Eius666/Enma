'use strict';

const { admin, db } = require('../firebaseAdmin');

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLocalTime(isoUtc, timezone) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).format(new Date(isoUtc));
  } catch (_) {
    return isoUtc;
  }
}

async function getUserTimezone(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  return userDoc.data()?.timezone || 'Europe/Warsaw';
}

// ── Task callback handler (called from webhook [4a]) ──────────────────────────

const TG = 'https://api.telegram.org';

async function handleTaskCallback(token, callbackQuery) {
  const { id: queryId, data, from } = callbackQuery;
  const chatId = from?.id;

  await fetch(`${TG}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: queryId }),
  }).catch(() => {});

  const match = data.match(/^task_(done|snooze15m|snooze1h|snooze3h|snoozetomorrow)_(.+)$/);
  if (!match) return;

  const [, action, taskId] = match;
  const docRef = db.collection('tasks').doc(taskId);
  const snap   = await docRef.get().catch(() => null);
  if (!snap?.exists) {
    await send(token, chatId, '❌ Задача не найдена');
    return;
  }

  const task     = snap.data();
  const timezone = await getUserTimezone(task.userId).catch(() => 'Europe/Warsaw');

  switch (action) {
    case 'done': {
      await docRef.update({
        status:      'done',
        completed:   true,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
      await send(token, chatId, `✅ Выполнено: "${task.title}"`);
      break;
    }
    case 'snooze15m':
    case 'snooze1h':
    case 'snooze3h': {
      const mins    = action === 'snooze15m' ? 15 : action === 'snooze1h' ? 60 : 180;
      const newTime = new Date(Date.now() + mins * 60 * 1000);
      await docRef.update({
        scheduledAt:  admin.firestore.Timestamp.fromDate(newTime),
        snoozedUntil: admin.firestore.Timestamp.fromDate(newTime),
        reminderSent: false,
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
      await send(token, chatId, `😴 Отложено на ${mins < 60 ? mins + ' мин' : mins / 60 + ' ч'} (${formatLocalTime(newTime.toISOString(), timezone)})`);
      break;
    }
    case 'snoozetomorrow': {
      const at      = task.scheduledAt?.toDate ? task.scheduledAt.toDate() : new Date();
      const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
      await docRef.update({
        scheduledAt:  admin.firestore.Timestamp.fromDate(tomorrow),
        snoozedUntil: admin.firestore.Timestamp.fromDate(tomorrow),
        reminderSent: false,
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
      await send(token, chatId, `📅 Перенесено на завтра (${formatLocalTime(tomorrow.toISOString(), timezone)})`);
      break;
    }
  }
}

async function send(token, chatId, text) {
  await fetch(`${TG}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

module.exports = { handleTaskCallback };
