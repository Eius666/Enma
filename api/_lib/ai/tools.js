'use strict';

const { admin, db } = require('../firebaseAdmin');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── Tool definitions (OpenAI function-calling format, works with OpenRouter) ──

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
          triggerAt: { type: 'string', description: 'ISO 8601 datetime когда отправить, например 2026-07-03T19:00:00' },
        },
        required: ['text', 'triggerAt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Добавить задачу в список дел пользователя.',
      parameters: {
        type: 'object',
        properties: {
          title:    { type: 'string', description: 'Название задачи' },
          dueDate:  { type: 'string', description: 'Дедлайн YYYY-MM-DD (опционально)' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Приоритет (по умолчанию medium)' },
        },
        required: ['title'],
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
          status: { type: 'string', enum: ['all', 'pending', 'completed'], description: 'Фильтр по статусу (по умолчанию pending)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Создать событие в календаре пользователя.',
      parameters: {
        type: 'object',
        properties: {
          title:           { type: 'string', description: 'Название события' },
          date:            { type: 'string', description: 'Дата YYYY-MM-DD' },
          time:            { type: 'string', description: 'Время HH:MM (опционально)' },
          durationMinutes: { type: 'number', description: 'Длительность в минутах (по умолчанию 60)' },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Сохранить заметку пользователя.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Текст заметки' },
          tag:     { type: 'string', description: 'Тег или категория (опционально)' },
        },
        required: ['content'],
      },
    },
  },
];

// ── Tool executors ─────────────────────────────────────────────────────────────

async function executeTool(name, input, { userId, telegramChatId }) {
  switch (name) {
    case 'create_reminder': {
      const triggerAt = new Date(input.triggerAt);
      if (isNaN(triggerAt)) return { ok: false, error: 'Неверный формат даты' };
      const id = createId();
      await db.collection('reminders').doc(id).set({
        id,
        userId,
        telegramChatId,
        text:      String(input.text).slice(0, 1000),
        triggerAt: triggerAt.toISOString(),
        sent:      false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Напоминание запланировано на ${triggerAt.toISOString()}` };
    }

    case 'create_task': {
      const id = createId();
      await db.collection('tasks').doc(id).set({
        id,
        userId,
        title:     String(input.title).slice(0, 500),
        dueDate:   input.dueDate  || null,
        priority:  ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium',
        completed: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Задача "${input.title}" создана` };
    }

    case 'list_tasks': {
      const status = input.status || 'pending';
      const snap   = await db.collection('tasks').where('userId', '==', userId).limit(30).get();
      const all    = snap.docs.map(d => d.data());
      const items  = all.filter(t => {
        if (status === 'pending')   return !t.completed;
        if (status === 'completed') return  t.completed;
        return true;
      });
      if (!items.length) return { ok: true, tasks: [], message: 'Задач нет' };
      const lines = items.map(t =>
        `• ${t.title}` +
        (t.dueDate  ? ` (до ${t.dueDate})`          : '') +
        (t.priority !== 'medium' ? ` [${t.priority}]` : '')
      );
      return { ok: true, tasks: lines, message: lines.join('\n') };
    }

    case 'create_calendar_event': {
      const id = createId();
      await db.collection('events').doc(id).set({
        id,
        userId,
        title:           String(input.title).slice(0, 500),
        date:            String(input.date),
        time:            input.time            || null,
        durationMinutes: Number(input.durationMinutes) || 60,
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, message: `Событие "${input.title}" добавлено на ${input.date}` };
    }

    case 'create_note': {
      const id = createId();
      await db.collection('notes').doc(id).set({
        id,
        userId,
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

module.exports = { TOOL_DEFINITIONS, executeTool };
