'use strict';

const { db, admin } = require('./firebaseAdmin');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Moscow → UTC: subtract 3 hours
function mskToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min]  = timeStr ? timeStr.split(':').map(Number) : [9, 0];
  return new Date(Date.UTC(y, m - 1, d, h - 3, min));
}

// ── Tool definitions (OpenAI function-calling format) ────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Создать напоминание. Используй когда пользователь просит напомнить что-либо.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Текст напоминания' },
          scheduledAt: { type: 'string', description: 'Дата и время ISO 8601 UTC (конвертируй из МСК UTC+3)' },
          description: { type: 'string', description: 'Дополнительное описание (опционально)' },
        },
        required: ['title', 'scheduledAt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать задачу. Используй когда пользователь хочет добавить задачу или дело.',
      parameters: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Название задачи' },
          date:        { type: 'string', description: 'Дата YYYY-MM-DD' },
          time:        { type: 'string', description: 'Время HH:MM по МСК (опционально)' },
          description: { type: 'string', description: 'Описание (опционально)' },
          category: {
            type: 'string',
            enum: ['work', 'personal', 'health', 'study', 'finance', 'other'],
          },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_transaction',
      description: 'Записать расход или доход. Используй когда пользователь упоминает сумму и на что потратил/получил.',
      parameters: {
        type: 'object',
        properties: {
          amount:      { type: 'number', description: 'Сумма' },
          description: { type: 'string', description: 'Описание' },
          type:        { type: 'string', enum: ['expense', 'income'] },
          category:    { type: 'string', description: 'Категория (еда, транспорт, зарплата, etc.)' },
        },
        required: ['amount', 'description', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_reminders',
      description: 'Показать список напоминаний пользователя.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'sent', 'all'] },
          limit:  { type: 'number', description: 'Максимальное количество (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_tasks',
      description: 'Показать список задач пользователя.',
      parameters: {
        type: 'object',
        properties: {
          date:  { type: 'string', description: 'Фильтр по дате YYYY-MM-DD (опционально)' },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_transactions',
      description: 'Показать историю расходов/доходов.',
      parameters: {
        type: 'object',
        properties: {
          type:  { type: 'string', enum: ['expense', 'income', 'all'] },
          limit: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Найти актуальную информацию: курсы валют, погода, новости, цены.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
        },
        required: ['query'],
      },
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────

async function createReminder(args, userId, chatId) {
  const { title, scheduledAt, description } = args;
  const schedDate = new Date(scheduledAt);

  if (isNaN(schedDate.getTime())) return { ok: false, error: 'Неверный формат даты' };
  if (schedDate <= new Date())    return { ok: false, error: 'Время должно быть в будущем' };

  const id = createId();
  await db.collection('reminders').doc(id).set({
    userId,
    chatId,
    title,
    description: description || '',
    scheduledAt: admin.firestore.Timestamp.fromDate(schedDate),
    status:      'pending',
    telegramText: `⏰ Напоминание: ${title}`,
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  const mskStr = schedDate.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  return { ok: true, message: `✅ Напоминание создано: «${title}» — ${mskStr} (МСК)` };
}

async function createTask(args, userId, chatId) {
  const { title, date, time, description, category } = args;
  const id = createId();

  await db.collection('tasks').doc(id).set({
    userId,
    chatId,
    title,
    date,
    time:        time   || null,
    description: description || '',
    category:    category || 'other',
    done:        false,
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  // Create companion reminder if time is given
  if (time) {
    const taskDate = mskToUtc(date, time);
    if (taskDate > new Date()) {
      await db.collection('reminders').doc(createId()).set({
        userId,
        chatId,
        title,
        description:  description || '',
        scheduledAt:  admin.firestore.Timestamp.fromDate(taskDate),
        status:       'pending',
        telegramText: `📋 Задача: ${title}`,
        source:       'telegram-bot',
        taskId:       id,
        createdAt:    admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  const timeStr = time ? ` в ${time} МСК` : '';
  return { ok: true, message: `✅ Задача создана: «${title}» на ${date}${timeStr}` };
}

async function createTransaction(args, userId, chatId) {
  const { amount, description, type, category } = args;
  const id = createId();

  await db.collection('transactions').doc(id).set({
    userId,
    chatId,
    type,
    amount,
    description,
    categoryId: category ? `cat-${category}` : 'cat-other',
    date:       new Date().toISOString(),
    source:     'telegram-bot',
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  const emoji = type === 'income' ? '💰' : '💸';
  const verb  = type === 'income' ? 'Доход' : 'Расход';
  return { ok: true, message: `${emoji} ${verb}: ${description} — ${amount} ₽` };
}

async function queryReminders(args, userId) {
  const { status = 'pending', limit = 10 } = args || {};

  let q = db.collection('reminders').where('userId', '==', userId);
  if (status !== 'all') q = q.where('status', '==', status);
  q = q.orderBy('scheduledAt', 'desc').limit(Math.min(limit, 20));

  const snap = await q.get();
  if (snap.empty) return { ok: true, message: 'Нет напоминаний.' };

  const icons = { pending: '⏳', sent: '✅', sending: '🔄', failed: '❌' };
  const lines = snap.docs.map(d => {
    const r   = d.data();
    const ts  = r.scheduledAt?.toDate?.();
    const tStr = ts ? ts.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }) : '—';
    return `${icons[r.status] || '⏳'} ${r.title} — ${tStr} МСК`;
  });
  return { ok: true, message: `📅 Напоминания:\n${lines.join('\n')}` };
}

async function queryTasks(args, userId) {
  const { date, limit = 10 } = args || {};

  let q = db.collection('tasks').where('userId', '==', userId);
  if (date) q = q.where('date', '==', date);
  q = q.orderBy('date', 'desc').limit(Math.min(limit, 20));

  const snap = await q.get();
  if (snap.empty) return { ok: true, message: 'Нет задач.' };

  const lines = snap.docs.map(d => {
    const t     = d.data();
    const icon  = t.done ? '✅' : '📋';
    const tStr  = t.time ? ` в ${t.time}` : '';
    return `${icon} ${t.title} — ${t.date}${tStr}`;
  });
  return { ok: true, message: `📋 Задачи:\n${lines.join('\n')}` };
}

async function queryTransactions(args, userId) {
  const { type = 'all', limit = 10 } = args || {};

  let q = db.collection('transactions').where('userId', '==', userId);
  if (type !== 'all') q = q.where('type', '==', type);
  q = q.orderBy('date', 'desc').limit(Math.min(limit, 20));

  const snap = await q.get();
  if (snap.empty) return { ok: true, message: 'Нет транзакций.' };

  const lines = snap.docs.map(d => {
    const tx    = d.data();
    const emoji = tx.type === 'income' ? '💰' : '💸';
    return `${emoji} ${tx.description} — ${tx.amount} ₽`;
  });
  return { ok: true, message: `💳 История:\n${lines.join('\n')}` };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function executeTool(name, args, userId, chatId) {
  switch (name) {
    case 'create_reminder':    return createReminder(args, userId, chatId);
    case 'create_task':        return createTask(args, userId, chatId);
    case 'create_transaction': return createTransaction(args, userId, chatId);
    case 'query_reminders':    return queryReminders(args, userId);
    case 'query_tasks':        return queryTasks(args, userId);
    case 'query_transactions': return queryTransactions(args, userId);
    // search_web is handled by the caller, not here
    case 'search_web':         return { ok: false, error: 'SEARCH_WEB_REDIRECT', query: args?.query };
    default:                   return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
