'use strict';

const { db, admin } = require('./firebaseAdmin');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const DEFAULT_TZ = 'Europe/Warsaw';

// ── Timezone helpers ──────────────────────────────────────────────────────────

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(new Date());
    return true;
  } catch { return false; }
}

function getUtcOffsetStr(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz, timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value || tz;
  } catch { return tz; }
}

async function getUserTimezone(userId) {
  try {
    const doc = await db.collection('users').doc(userId).get();
    const tz  = doc.exists ? doc.data()?.timezone : null;
    return (tz && isValidTimezone(tz)) ? tz : DEFAULT_TZ;
  } catch { return DEFAULT_TZ; }
}

/**
 * Convert a local date+time string to UTC, respecting DST of the given timezone.
 * e.g. localToUtc('2026-07-30', '23:30', 'Europe/Warsaw') → 2026-07-30T21:30:00Z
 */
function localToUtc(dateStr, timeStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min]  = timeStr ? timeStr.split(':').map(Number) : [9, 0];

  // Treat the desired local time as if it were UTC
  const pseudo = new Date(Date.UTC(y, m - 1, d, h, min));

  // Find what the target timezone displays for this pseudo-UTC
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(pseudo);

  const p = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }

  // UTC ms that the timezone says equals pseudo
  const tzAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);

  // Offset = tzAsUtcMs - pseudo; actual UTC = pseudo - offset
  return new Date(pseudo.getTime() - (tzAsUtcMs - pseudo.getTime()));
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
          scheduledAt: { type: 'string', description: 'Дата и время ISO 8601 UTC (конвертируй из часового пояса пользователя в UTC)' },
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
          time:        { type: 'string', description: 'Время HH:MM по часовому поясу пользователя (опционально)' },
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
      name: 'set_timezone',
      description: 'Установить часовой пояс пользователя. Используй когда пользователь говорит где он находится или просит сменить часовой пояс.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone, например Europe/Warsaw, Europe/Moscow, America/New_York',
          },
        },
        required: ['timezone'],
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

async function createReminder(args, userId, chatId, timezone) {
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

  const tz     = timezone || DEFAULT_TZ;
  const offset = getUtcOffsetStr(tz);
  const tStr   = schedDate.toLocaleString('ru-RU', {
    timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  return { ok: true, message: `✅ Напоминание создано: «${title}» — ${tStr} (${offset})` };
}

async function createTask(args, userId, chatId, timezone) {
  const { title, date, time, description, category } = args;
  const id = createId();
  const tz = timezone || DEFAULT_TZ;

  await db.collection('tasks').doc(id).set({
    userId,
    chatId,
    title,
    date,
    time:        time || null,
    description: description || '',
    category:    category || 'other',
    done:        false,
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  // Companion reminder using the user's actual timezone for conversion
  if (time) {
    const taskDate = localToUtc(date, time, tz);
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

  const timeStr = time ? ` в ${time}` : '';
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

async function queryReminders(args, userId, timezone) {
  const { status = 'pending', limit = 10 } = args || {};
  const tz     = timezone || DEFAULT_TZ;
  const offset = getUtcOffsetStr(tz);

  let q = db.collection('reminders').where('userId', '==', userId);
  if (status !== 'all') q = q.where('status', '==', status);
  q = q.orderBy('scheduledAt', 'desc').limit(Math.min(limit, 20));

  const snap = await q.get();
  if (snap.empty) return { ok: true, message: 'Нет напоминаний.' };

  const icons = { pending: '⏳', sent: '✅', sending: '🔄', failed: '❌' };
  const lines = snap.docs.map(d => {
    const r    = d.data();
    const ts   = r.scheduledAt?.toDate?.();
    const tStr = ts ? ts.toLocaleString('ru-RU', {
      timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }) : '—';
    return `${icons[r.status] || '⏳'} ${r.title} — ${tStr} (${offset})`;
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
    const t    = d.data();
    const icon = t.done ? '✅' : '📋';
    const tStr = t.time ? ` в ${t.time}` : '';
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

async function setTimezone(args, userId) {
  const { timezone } = args;
  if (!isValidTimezone(timezone)) {
    return { ok: false, error: `Неверный часовой пояс: «${timezone}». Пример: Europe/Warsaw` };
  }
  await db.collection('users').doc(userId).update({ timezone });
  const offset = getUtcOffsetStr(timezone);
  return { ok: true, message: `✅ Часовой пояс обновлён: ${timezone} (${offset})` };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function executeTool(name, args, userId, chatId, timezone) {
  switch (name) {
    case 'create_reminder':    return createReminder(args, userId, chatId, timezone);
    case 'create_task':        return createTask(args, userId, chatId, timezone);
    case 'create_transaction': return createTransaction(args, userId, chatId);
    case 'query_reminders':    return queryReminders(args, userId, timezone);
    case 'query_tasks':        return queryTasks(args, userId);
    case 'query_transactions': return queryTransactions(args, userId);
    case 'set_timezone':       return setTimezone(args, userId);
    // search_web is intercepted by the caller
    case 'search_web':         return { ok: false, error: 'SEARCH_WEB_REDIRECT', query: args?.query };
    default:                   return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, getUserTimezone, isValidTimezone, getUtcOffsetStr };
