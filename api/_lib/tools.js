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

// ── Time parsing helpers ──────────────────────────────────────────────────────

function getTodayDateInTz(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // "YYYY-MM-DD"
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getLocalTimeStr(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return `${String(parseInt(p.hour, 10) % 24).padStart(2, '0')}:${p.minute}`;
}

/**
 * Parse a human-readable Russian time expression into a UTC Date.
 * Examples: "через 5 минут", "в 23:30", "завтра в 9 утра", "через 2 часа"
 */
function parseRelativeTime(text, timezone) {
  const tz    = timezone || DEFAULT_TZ;
  const now   = new Date();
  const lower = (text || '').toLowerCase().trim();

  // "через N минут/часов/дней/недель"
  const throughMatch = lower.match(/через\s+(\d+)\s+(минут|минуты|минуту|час|часа|часов|день|дня|дней|недел[юьи])/);
  if (throughMatch) {
    const num  = parseInt(throughMatch[1], 10);
    const unit = throughMatch[2];
    if (unit.startsWith('мин')) return new Date(now.getTime() + num * 60_000);
    if (unit.startsWith('час')) return new Date(now.getTime() + num * 3_600_000);
    if (unit.startsWith('не'))  return new Date(now.getTime() + num * 7 * 86_400_000);
    return new Date(now.getTime() + num * 86_400_000); // день/дня/дней
  }

  // Determine day offset
  let dayOffset   = 0;
  let explicitDay = false;
  if      (lower.includes('послезавтра')) { dayOffset = 2; explicitDay = true; }
  else if (lower.includes('завтра'))      { dayOffset = 1; explicitDay = true; }
  else if (lower.includes('сегодня'))     { explicitDay = true; }

  // Extract HH:MM — "HH:MM", "HH.MM", or "N утра/вечера/дня/ночи"
  let h = -1, m = 0;
  const colonMatch = lower.match(/(\d{1,2})[:\.](\d{2})/);
  if (colonMatch) {
    h = parseInt(colonMatch[1], 10);
    m = parseInt(colonMatch[2], 10);
    if (/вечер|ночи/.test(lower) && h < 12) h += 12;
    else if (/утра/.test(lower) && h === 12) h = 0;
  } else {
    const bareMatch = lower.match(/(?:^|[\s,])(\d{1,2})\s*(утра|дня|вечера|ночи)/);
    if (bareMatch) {
      h = parseInt(bareMatch[1], 10);
      const period = bareMatch[2];
      if ((period === 'вечера' || period === 'ночи') && h < 12) h += 12;
      else if (period === 'утра' && h === 12) h = 0;
    } else {
      const simpleMatch = lower.match(/\bв\s+(\d{1,2})\b/);
      if (simpleMatch) h = parseInt(simpleMatch[1], 10);
    }
  }

  if (h >= 0) {
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    let dateStr   = getTodayDateInTz(tz);
    if (dayOffset > 0) dateStr = addDaysToDateStr(dateStr, dayOffset);

    const utcDate = localToUtc(dateStr, timeStr, tz);
    // Auto-shift to tomorrow only when no explicit day mentioned and time already passed
    if (!explicitDay && utcDate <= now) {
      return localToUtc(addDaysToDateStr(dateStr, 1), timeStr, tz);
    }
    return utcDate;
  }

  // ISO 8601 with Z (or parseable by Date constructor)
  const direct = new Date(text);
  if (!isNaN(direct.getTime())) return direct;

  // "YYYY-MM-DD HH:MM" with space — treat bare datetime as UTC
  const spaceMatch = (text || '').match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (spaceMatch) return new Date(`${spaceMatch[1]}T${spaceMatch[2]}:00Z`);

  return null;
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
          title:         { type: 'string', description: 'Текст напоминания' },
          relative_time: { type: 'string', description: 'Время ТОЧНО как сказал пользователь: "через 5 минут", "в 23:30", "завтра в 9 утра", "через 2 часа". НЕ конвертируй в ISO — передай оригинальную фразу.' },
          description:   { type: 'string', description: 'Дополнительное описание (опционально)' },
        },
        required: ['title', 'relative_time'],
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
          title:         { type: 'string', description: 'Название задачи' },
          date:          { type: 'string', description: 'Дата YYYY-MM-DD (если известна)' },
          relative_time: { type: 'string', description: 'Время ТОЧНО как сказал пользователь: "в 14:00", "в 9 утра", "завтра в 10:00". НЕ конвертируй — передай оригинальную фразу.' },
          description:   { type: 'string', description: 'Описание (опционально)' },
          category: {
            type: 'string',
            enum: ['work', 'personal', 'health', 'study', 'finance', 'other'],
          },
        },
        required: ['title'],
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
  console.log('[create_reminder] raw args:', JSON.stringify(args));

  const { title, relative_time, description } = args;
  const tz = timezone || DEFAULT_TZ;

  const scheduled = parseRelativeTime(relative_time, tz);

  if (!scheduled || isNaN(scheduled.getTime())) {
    console.error('[create_reminder] unparseable relative_time:', relative_time);
    return { ok: false, error: `Не удалось распознать время: «${relative_time}». Попробуй написать иначе, например: «через 30 минут» или «завтра в 10 утра».` };
  }
  if (scheduled <= new Date()) {
    return { ok: false, error: 'Время должно быть в будущем' };
  }

  const id = createId();
  await db.collection('reminders').doc(id).set({
    userId,
    chatId,
    title,
    description:  description || '',
    scheduledAt:  admin.firestore.Timestamp.fromDate(scheduled),
    status:       'pending',
    telegramText: `⏰ Напоминание: ${title}`,
    source:       'telegram-bot',
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
  });

  const offset = getUtcOffsetStr(tz);
  const tStr   = scheduled.toLocaleString('ru-RU', {
    timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  console.log('[create_reminder] saved', id, 'scheduledAt:', scheduled.toISOString());
  return { ok: true, message: `✅ Напоминание создано: «${title}» — ${tStr} (${offset})` };
}

async function createTask(args, userId, chatId, timezone) {
  console.log('[create_task] raw args:', JSON.stringify(args));

  const { title, date, relative_time, description, category } = args;
  const tz = timezone || DEFAULT_TZ;
  const id = createId();

  // Parse time from relative_time; if date provided, use it as base date for time-only expressions
  let taskUtcDate = null;
  let taskTime    = null; // HH:MM local for display
  let taskDate    = date || getTodayDateInTz(tz);

  if (relative_time) {
    // Check if relative_time has a HH:MM pattern but no date keywords → anchor to taskDate
    const hasDateKeyword = /завтра|сегодня|послезавтра|через\s+\d+\s+(день|дня|дней|недел)/.test(relative_time.toLowerCase());
    const timeOnlyMatch  = relative_time.match(/(\d{1,2})[:\.](\d{2})/);

    if (!hasDateKeyword && timeOnlyMatch && date) {
      // "в 14:00" with explicit date → anchor to that date
      const h = String(parseInt(timeOnlyMatch[1], 10)).padStart(2, '0');
      const m = String(parseInt(timeOnlyMatch[2], 10)).padStart(2, '0');
      taskTime    = `${h}:${m}`;
      taskUtcDate = localToUtc(date, taskTime, tz);
    } else {
      taskUtcDate = parseRelativeTime(relative_time, tz);
      if (taskUtcDate && !isNaN(taskUtcDate.getTime())) {
        taskTime = getLocalTimeStr(taskUtcDate, tz);
        // If relative_time implied a different date (e.g. "завтра"), update taskDate
        if (hasDateKeyword || !date) {
          taskDate = getTodayDateInTz(tz);
          // Derive date in user's TZ from the parsed UTC time
          taskDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(taskUtcDate);
        }
      }
    }
  }

  await db.collection('tasks').doc(id).set({
    userId,
    chatId,
    title,
    date:        taskDate,
    time:        taskTime || null,
    description: description || '',
    category:    category || 'other',
    done:        false,
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  if (taskUtcDate && !isNaN(taskUtcDate.getTime()) && taskUtcDate > new Date()) {
    await db.collection('reminders').doc(createId()).set({
      userId,
      chatId,
      title,
      description:  description || '',
      scheduledAt:  admin.firestore.Timestamp.fromDate(taskUtcDate),
      status:       'pending',
      telegramText: `📋 Задача: ${title}`,
      source:       'telegram-bot',
      taskId:       id,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const timeStr = taskTime ? ` в ${taskTime}` : '';
  return { ok: true, message: `✅ Задача создана: «${title}» на ${taskDate}${timeStr}` };
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
