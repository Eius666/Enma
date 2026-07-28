'use strict';

const { admin, db } = require('../firebaseAdmin');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Создать напоминание: бот отправит сообщение пользователю в указанное время.',
      parameters: {
        type: 'object',
        properties: {
          text:      { type: 'string', description: 'Текст напоминания' },
          triggerAt: { type: 'string', description: 'ISO 8601 с offset пользователя, например 2026-07-03T19:00:00+02:00' },
        },
        required: ['text', 'triggerAt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать задачу / событие в расписании пользователя. ОБЯЗАТЕЛЬНО вызывай когда пользователь говорит "напомни", "запланируй", "добавь в расписание", "позвоню в X", "встреча в Y".',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string',  description: 'Название задачи' },
          description: { type: 'string',  description: 'Описание (опционально)' },
          scheduledAt: { type: 'string',  description: 'Время выполнения — ISO 8601 UTC, например 2026-07-24T12:00:00Z. Конвертируй из локального времени пользователя в UTC.' },
          durationMin: { type: 'number',  description: 'Длительность в минутах (по умолчанию 30)' },
          priority:    { type: 'string',  enum: ['low', 'medium', 'high'], description: 'Приоритет' },
          category:    { type: 'string',  description: 'Категория: work, personal, health, finance и т.д.' },
        },
        required: ['title', 'scheduledAt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Получить список задач пользователя.',
      parameters: {
        type: 'object',
        properties: {
          dateFrom: { type: 'string', description: 'Начало диапазона ISO 8601 UTC (опционально)' },
          dateTo:   { type: 'string', description: 'Конец диапазона ISO 8601 UTC (опционально)' },
          status:   { type: 'string', enum: ['all', 'pending', 'in_progress', 'done', 'cancelled'], description: 'Фильтр по статусу (по умолчанию pending)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Обновить существующую задачу.',
      parameters: {
        type: 'object',
        properties: {
          taskId:      { type: 'string', description: 'ID задачи из list_tasks' },
          title:       { type: 'string' },
          description: { type: 'string' },
          scheduledAt: { type: 'string', description: 'Новое время UTC ISO 8601' },
          priority:    { type: 'string', enum: ['low', 'medium', 'high'] },
          status:      { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Отметить задачу выполненной.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Удалить задачу.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snooze_task',
      description: 'Отложить задачу на N минут.',
      parameters: {
        type: 'object',
        properties: {
          taskId:  { type: 'string' },
          minutes: { type: 'number', description: 'На сколько минут отложить' },
        },
        required: ['taskId', 'minutes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_timezone',
      description: 'Обновить часовой пояс пользователя если из контекста ясно что он в другом городе/стране. Передавай IANA timezone (Europe/Warsaw, Asia/Tokyo и т.д.).',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone' },
          source:   { type: 'string', description: 'Откуда стало известно: "user mentioned city", "user said timezone" и т.д.' },
        },
        required: ['timezone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Создать событие в календаре.',
      parameters: {
        type: 'object',
        properties: {
          title:           { type: 'string' },
          date:            { type: 'string', description: 'YYYY-MM-DD' },
          time:            { type: 'string', description: 'HH:MM (опционально)' },
          durationMinutes: { type: 'number' },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Сохранить заметку.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          tag:     { type: 'string' },
        },
        required: ['content'],
      },
    },
  },
];

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

async function logToolCall(userId, toolName, args, result, latencyMs, success, errorMessage) {
  await db.collection('tool_calls').add({
    userId,
    toolName,
    args,
    result,
    latencyMs,
    success,
    errorMessage: errorMessage || null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {}); // logging is non-fatal
}

// ── Tool executors ─────────────────────────────────────────────────────────────

async function executeTool(name, input, { userId, telegramChatId, userTimezone = 'Europe/Warsaw' }) {
  const t0 = Date.now();
  let result;
  let success = true;
  let errorMessage;

  try {
    result = await _executeToolInner(name, input, { userId, telegramChatId, userTimezone });
    if (result.ok === false) { success = false; errorMessage = result.error; }
  } catch (err) {
    success = false;
    errorMessage = err.message;
    result = { ok: false, error: err.message };
  }

  await logToolCall(userId, name, input, result, Date.now() - t0, success, errorMessage);
  return result;
}

async function _executeToolInner(name, input, { userId, telegramChatId, userTimezone }) {
  switch (name) {

    // ── Reminder ───────────────────────────────────────────────────────────────
    case 'create_reminder': {
      const triggerAt = new Date(input.triggerAt);
      if (isNaN(triggerAt)) return { ok: false, error: 'Неверный формат даты' };
      const id = createId();
      await db.collection('reminders').doc(id).set({
        id, userId, telegramChatId,
        text:      String(input.text).slice(0, 1000),
        triggerAt: triggerAt.toISOString(),
        timezone:  userTimezone,
        sent:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Напоминание запланировано на ${formatLocalTime(triggerAt.toISOString(), userTimezone)}` };
    }

    // ── Create task ────────────────────────────────────────────────────────────
    case 'create_task': {
      const scheduledAt = new Date(input.scheduledAt);
      if (isNaN(scheduledAt)) return { ok: false, error: 'Неверный формат scheduledAt' };

      const id = createId();
      await db.collection('tasks').doc(id).set({
        id, userId, telegramChatId,
        title:        String(input.title).slice(0, 500),
        description:  input.description ? String(input.description).slice(0, 2000) : null,
        scheduledAt:  admin.firestore.Timestamp.fromDate(scheduledAt),
        durationMin:  Number(input.durationMin) || 30,
        status:       'pending',
        priority:     ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium',
        category:     input.category || null,
        reminderSent: false,
        snoozedUntil: null,
        completedAt:  null,
        source:       'agent',
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        ok: true,
        taskId: id,
        message: `Задача "${input.title}" запланирована на ${formatLocalTime(scheduledAt.toISOString(), userTimezone)}`,
      };
    }

    // ── List tasks ─────────────────────────────────────────────────────────────
    case 'list_tasks': {
      const statusFilter = input.status || 'pending';
      const snap = await db.collection('tasks').where('userId', '==', userId).limit(50).get();
      let items = snap.docs.map(d => d.data());

      // Filter by status
      if (statusFilter !== 'all') {
        items = items.filter(t => (t.status || (t.completed ? 'done' : 'pending')) === statusFilter);
      }

      // Filter by date range
      if (input.dateFrom) {
        const from = new Date(input.dateFrom);
        items = items.filter(t => {
          const at = t.scheduledAt?.toDate ? t.scheduledAt.toDate() : (t.dueDate ? new Date(t.dueDate) : null);
          return at && at >= from;
        });
      }
      if (input.dateTo) {
        const to = new Date(input.dateTo);
        items = items.filter(t => {
          const at = t.scheduledAt?.toDate ? t.scheduledAt.toDate() : (t.dueDate ? new Date(t.dueDate) : null);
          return at && at <= to;
        });
      }

      // Sort by scheduledAt
      items.sort((a, b) => {
        const aAt = a.scheduledAt?.toDate?.()?.getTime() || 0;
        const bAt = b.scheduledAt?.toDate?.()?.getTime() || 0;
        return aAt - bAt;
      });

      if (!items.length) return { ok: true, tasks: [], message: 'Задач нет' };

      const lines = items.map(t => {
        const at = t.scheduledAt?.toDate ? t.scheduledAt.toDate() : (t.dueDate ? new Date(t.dueDate) : null);
        const timeStr = at ? formatLocalTime(at.toISOString(), userTimezone) : '';
        const prio    = t.priority && t.priority !== 'medium' ? ` [${t.priority}]` : '';
        const stat    = t.status && t.status !== 'pending' ? ` (${t.status})` : '';
        return `• [${t.id}] ${t.title}${timeStr ? ' — ' + timeStr : ''}${prio}${stat}`;
      });

      return { ok: true, tasks: items.map(t => ({ id: t.id, title: t.title })), message: lines.join('\n') };
    }

    // ── Update task ────────────────────────────────────────────────────────────
    case 'update_task': {
      const docRef = db.collection('tasks').doc(input.taskId);
      const snap   = await docRef.get();
      if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Задача не найдена' };

      const upd = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (input.title)       upd.title       = String(input.title).slice(0, 500);
      if (input.description) upd.description = String(input.description).slice(0, 2000);
      if (input.scheduledAt) {
        const d = new Date(input.scheduledAt);
        if (!isNaN(d)) { upd.scheduledAt = admin.firestore.Timestamp.fromDate(d); upd.reminderSent = false; }
      }
      if (input.priority) upd.priority = input.priority;
      if (input.status)   upd.status   = input.status;

      await docRef.update(upd);
      return { ok: true, message: 'Задача обновлена' };
    }

    // ── Complete task ──────────────────────────────────────────────────────────
    case 'complete_task': {
      const docRef = db.collection('tasks').doc(input.taskId);
      const snap   = await docRef.get();
      if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Задача не найдена' };
      await docRef.update({
        status:      'done',
        completed:   true,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Задача "${snap.data().title}" выполнена ✅` };
    }

    // ── Delete task ────────────────────────────────────────────────────────────
    case 'delete_task': {
      const docRef = db.collection('tasks').doc(input.taskId);
      const snap   = await docRef.get();
      if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Задача не найдена' };
      const title = snap.data().title;
      await docRef.update({
        status:    'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Задача "${title}" удалена` };
    }

    // ── Snooze task ────────────────────────────────────────────────────────────
    case 'snooze_task': {
      const mins   = Number(input.minutes) || 15;
      const docRef = db.collection('tasks').doc(input.taskId);
      const snap   = await docRef.get();
      if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Задача не найдена' };

      const newTime = new Date(Date.now() + mins * 60 * 1000);
      await docRef.update({
        scheduledAt:  admin.firestore.Timestamp.fromDate(newTime),
        snoozedUntil: admin.firestore.Timestamp.fromDate(newTime),
        reminderSent: false,
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Задача отложена на ${mins} мин (${formatLocalTime(newTime.toISOString(), userTimezone)})` };
    }

    // ── Update timezone ────────────────────────────────────────────────────────
    case 'update_timezone': {
      const tz = input.timezone;
      try { Intl.DateTimeFormat(undefined, { timeZone: tz }); } catch (_) {
        return { ok: false, error: `Неверный часовой пояс: ${tz}` };
      }
      await db.collection('users').doc(userId).set({
        timezone:              tz,
        timezoneConfidence:    'inferred',
        timezoneInferredFrom:  [input.source || 'ai_inference'],
      }, { merge: true });
      return { ok: true, message: `Часовой пояс обновлён: ${tz}` };
    }

    // ── Calendar event ─────────────────────────────────────────────────────────
    case 'create_calendar_event': {
      const id = createId();
      await db.collection('events').doc(id).set({
        id, userId,
        title:           String(input.title).slice(0, 500),
        date:            String(input.date),
        time:            input.time            || null,
        durationMinutes: Number(input.durationMinutes) || 60,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Событие "${input.title}" добавлено на ${input.date}${input.time ? ' ' + input.time : ''}` };
    }

    // ── Note ───────────────────────────────────────────────────────────────────
    case 'create_note': {
      const id = createId();
      await db.collection('notes').doc(id).set({
        id, userId,
        content:   String(input.content).slice(0, 5000),
        tag:       input.tag || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: 'Заметка сохранена' };
    }

    default:
      return { ok: false, error: `Неизвестный инструмент: ${name}` };
  }
}

// ── Task callback handler (called from webhook [4a]) ──────────────────────────

const TG = 'https://api.telegram.org';

async function handleTaskCallback(token, callbackQuery) {
  const { id: queryId, data, from } = callbackQuery;
  const chatId = from?.id;

  // Answer immediately to avoid Telegram "loading" state
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
      const mins = action === 'snooze15m' ? 15 : action === 'snooze1h' ? 60 : 180;
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
      const at = task.scheduledAt?.toDate ? task.scheduledAt.toDate() : new Date();
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

async function getUserTimezone(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  return userDoc.data()?.timezone || 'Europe/Warsaw';
}

module.exports = { TOOL_DEFINITIONS, executeTool, handleTaskCallback };
