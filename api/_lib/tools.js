'use strict';

const { db, admin } = require('./firebaseAdmin');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const DEFAULT_TZ = 'Europe/Warsaw';

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', RUB: '₽', BYN: 'Br', CNY: '¥' };

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

async function getUserCurrency(userId) {
  try {
    const doc = await db.collection('users').doc(userId).get();
    return (doc.exists ? doc.data()?.currency : null) || 'RUB';
  } catch { return 'RUB'; }
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

// ── Automation scheduling helpers ────────────────────────────────────────────

const DOW_NAMES_RU = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** ISO weekday (1=Mon…7=Sun) for a YYYY-MM-DD string (computed in UTC noon). */
function isoDow(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

/**
 * Calculate the NEXT UTC Date for a recurring automation after `fromDate`.
 * fromDate should be the previous nextRunAt (already triggered).
 */
function calculateNextRun(scheduleType, scheduleData, fromDate, timezone) {
  const tz  = timezone || DEFAULT_TZ;
  const { time, daysOfWeek, dayOfMonth } = scheduleData;

  // Date string in user's timezone for the "from" moment
  const fromDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(fromDate);

  if (scheduleType === 'daily') {
    return localToUtc(addDaysToDateStr(fromDateStr, 1), time, tz);
  }

  if (scheduleType === 'weekly') {
    const days   = (daysOfWeek || [1]).slice().sort((a, b) => a - b);
    const curDow = isoDow(fromDateStr);
    // Find next matching day (offset 1..7 from current)
    for (let offset = 1; offset <= 7; offset++) {
      const nextDow = ((curDow - 1 + offset) % 7) + 1;
      if (days.includes(nextDow)) {
        return localToUtc(addDaysToDateStr(fromDateStr, offset), time, tz);
      }
    }
    return localToUtc(addDaysToDateStr(fromDateStr, 7), time, tz);
  }

  if (scheduleType === 'monthly') {
    const dom  = dayOfMonth || 1;
    const base = new Date(fromDateStr + 'T12:00:00Z');
    let y = base.getUTCFullYear();
    let m = base.getUTCMonth() + 1; // 1-based

    // Advance to next month
    m += 1;
    if (m > 12) { m = 1; y += 1; }

    const daysInMonth = new Date(y, m, 0).getDate();
    const actualDay   = Math.min(dom, daysInMonth);
    const dateStr     = `${y}-${String(m).padStart(2, '0')}-${String(actualDay).padStart(2, '0')}`;
    return localToUtc(dateStr, time, tz);
  }

  // Fallback
  return new Date(fromDate.getTime() + 86_400_000);
}

/**
 * Calculate the FIRST nextRunAt when creating a new automation.
 * Picks the nearest upcoming occurrence that hasn't started yet.
 */
function calculateFirstRun(scheduleType, scheduleData, timezone) {
  const tz  = timezone || DEFAULT_TZ;
  const { time, daysOfWeek, dayOfMonth } = scheduleData;
  const now = new Date();

  if (scheduleType === 'daily') {
    const today     = getTodayDateInTz(tz);
    const candidate = localToUtc(today, time, tz);
    return candidate > now ? candidate : localToUtc(addDaysToDateStr(today, 1), time, tz);
  }

  if (scheduleType === 'weekly') {
    const days    = (daysOfWeek || [1]).slice().sort((a, b) => a - b);
    const today   = getTodayDateInTz(tz);
    const todayDow = isoDow(today);

    // Check today if it's a target day and time hasn't passed
    if (days.includes(todayDow)) {
      const candidate = localToUtc(today, time, tz);
      if (candidate > now) return candidate;
    }
    // Scan next 7 days
    for (let offset = 1; offset <= 7; offset++) {
      const nextDow = ((todayDow - 1 + offset) % 7) + 1;
      if (days.includes(nextDow)) {
        return localToUtc(addDaysToDateStr(today, offset), time, tz);
      }
    }
    return localToUtc(addDaysToDateStr(today, 7), time, tz);
  }

  if (scheduleType === 'monthly') {
    const dom   = dayOfMonth || 1;
    const today = getTodayDateInTz(tz);
    const base  = new Date(today + 'T12:00:00Z');
    const y0    = base.getUTCFullYear();
    const m0    = base.getUTCMonth() + 1;

    // Try this month
    const daysInM0 = new Date(y0, m0, 0).getDate();
    if (dom <= daysInM0) {
      const dateStr   = `${y0}-${String(m0).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
      const candidate = localToUtc(dateStr, time, tz);
      if (candidate > now) return candidate;
    }

    // Next month
    const m1 = m0 === 12 ? 1 : m0 + 1;
    const y1 = m0 === 12 ? y0 + 1 : y0;
    const daysInM1 = new Date(y1, m1, 0).getDate();
    const actualDay = Math.min(dom, daysInM1);
    return localToUtc(`${y1}-${String(m1).padStart(2, '0')}-${String(actualDay).padStart(2, '0')}`, time, tz);
  }

  return localToUtc(addDaysToDateStr(getTodayDateInTz(tz), 1), time, tz);
}

function formatScheduleRu(scheduleType, scheduleData) {
  const { time, daysOfWeek, dayOfMonth } = scheduleData;
  if (scheduleType === 'daily')   return `Каждый день в ${time}`;
  if (scheduleType === 'weekly')  return `Каждый ${(daysOfWeek || []).map(d => DOW_NAMES_RU[d] || d).join(', ')} в ${time}`;
  if (scheduleType === 'monthly') return `${dayOfMonth}-го числа каждого месяца в ${time}`;
  return `${scheduleType} в ${time}`;
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
          bank:        { type: 'string', description: 'Банк или платёжный метод (Тинькофф, Сбербанк, Наличные, etc.). Спроси если у пользователя настроены банки.' },
          goalId:      { type: 'string', description: 'ID цели накопления если транзакция связана с целью' },
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
          bank:  { type: 'string', description: 'Фильтр по банку/платёжному методу (опционально)' },
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
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по описанию. Используй когда пользователь просит нарисовать, создать картинку, сгенерировать изображение.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Описание изображения на английском' },
          style:  {
            type: 'string',
            description: 'Стиль изображения (опционально)',
            enum: ['photo', 'illustration', '3d', 'anime', 'minimalist', 'pixel-art'],
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_finance_stats',
      description: 'Показать статистику расходов и доходов пользователя. Используй когда спрашивают про траты, бюджет, сколько потратил.',
      parameters: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            description: 'Период: today, week, month, all (по умолчанию month)',
            enum: ['today', 'week', 'month', 'all'],
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Отправить текстовое сообщение в указанный чат от имени бота. Используй когда пользователь просит отправить кому-то сообщение. Бот может отправлять только в чаты, где он уже есть участником или пользователь написал боту /start. Если chat_id не указан — спроси у пользователя.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'ID целевого чата (числовой ID или @username канала/группы)' },
          text:    { type: 'string', description: 'Текст сообщения' },
        },
        required: ['chat_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_automation',
      description: 'Создать повторяющееся автоматическое действие. Например: "каждый день в 8:00 напоминай про таблетки" или "каждый понедельник присылай расписание".',
      parameters: {
        type: 'object',
        properties: {
          name:          { type: 'string', description: 'Краткое название автоматизации' },
          message_text:  { type: 'string', description: 'Текст сообщения который бот будет отправлять' },
          schedule_type: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Тип повторения' },
          time:          { type: 'string', description: 'Время HH:MM по местному времени пользователя' },
          days_of_week:  { type: 'array',  items: { type: 'integer' }, description: 'Дни недели 1=Пн…7=Вс. Обязательно если schedule_type=weekly' },
          day_of_month:  { type: 'integer', description: 'День месяца 1-31. Обязательно если schedule_type=monthly' },
        },
        required: ['name', 'message_text', 'schedule_type', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_automations',
      description: 'Показать список активных автоматизаций пользователя.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_automation',
      description: 'Удалить автоматизацию по ID.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'ID автоматизации' },
        },
        required: ['automation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_automation',
      description: 'Поставить автоматизацию на паузу или возобновить.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'ID автоматизации' },
          action:        { type: 'string', enum: ['pause', 'resume'] },
        },
        required: ['automation_id', 'action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_message',
      description: 'Переслать сообщение из текущего чата пользователя в другой чат. Нужен message_id пересылаемого сообщения. Если chat_id не указан — спроси у пользователя.',
      parameters: {
        type: 'object',
        properties: {
          chat_id:      { type: 'string',  description: 'ID целевого чата' },
          from_chat_id: { type: 'string',  description: 'ID чата-источника (по умолчанию текущий чат пользователя — не указывай если не нужно)' },
          message_id:   { type: 'integer', description: 'ID сообщения для пересылки' },
        },
        required: ['chat_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_banks',
      description: 'Сохранить список банков/платёжных методов пользователя. Используй когда пользователь называет свои банки или хочет обновить список.',
      parameters: {
        type: 'object',
        properties: {
          banks: { type: 'array', items: { type: 'string' }, description: 'Список банков/методов оплаты, например ["Тинькофф", "Сбербанк", "Наличные"]' },
        },
        required: ['banks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_banks',
      description: 'Получить список банков/платёжных методов пользователя.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_goal',
      description: 'Создать цель накопления. Используй когда пользователь хочет накопить на что-то конкретное.',
      parameters: {
        type: 'object',
        properties: {
          title:        { type: 'string', description: 'Название цели, например "Отпуск в Испании"' },
          targetAmount: { type: 'number', description: 'Целевая сумма' },
          deadline:     { type: 'string', description: 'Дедлайн YYYY-MM-DD (опционально)' },
          category:     { type: 'string', description: 'Категория цели (опционально): travel, car, home, education, other' },
        },
        required: ['title', 'targetAmount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deposit_to_goal',
      description: 'Пополнить цель накопления на сумму.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели (из list_goals)' },
          amount: { type: 'number', description: 'Сумма пополнения' },
        },
        required: ['goalId', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'withdraw_from_goal',
      description: 'Снять средства с цели накопления.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели (из list_goals)' },
          amount: { type: 'number', description: 'Сумма снятия' },
        },
        required: ['goalId', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_goals',
      description: 'Показать все цели накопления пользователя с прогрессом.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_goal',
      description: 'Удалить цель накопления.',
      parameters: {
        type: 'object',
        properties: {
          goalId: { type: 'string', description: 'ID цели' },
        },
        required: ['goalId'],
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

function autoCategorize(description) {
  const lower = (description || '').toLowerCase();
  const rules = {
    food:          ['кофе', 'еда', 'ресторан', 'cafe', 'food', 'пицца', 'суши', 'бургер', 'обед', 'ужин', 'завтрак', 'продукт', 'маркет', 'доставка', 'перекус', 'фастфуд'],
    transport:     ['такси', 'метро', 'бензин', 'парковк', 'uber', 'bolt', 'yandex go', 'транспорт', 'билет', 'автобус', 'электричк'],
    entertainment: ['кино', 'фильм', 'игра', 'нетфликс', 'netflix', 'spotify', 'подписк', 'развлеч', 'концерт', 'театр'],
    shopping:      ['одежд', 'обувь', 'магазин', 'amazon', 'ozon', 'wildberries', 'покупк', 'шопинг'],
    bills:         ['аренд', 'коммунал', 'свет', 'интернет', 'телефон', 'хранени'],
    health:        ['аптек', 'врач', 'больниц', 'спорт', 'зал', 'фитнес', 'лекарств', 'витамин'],
    study:         ['курс', 'книг', 'обучен', 'удем', 'skillbox', 'учёба'],
  };
  for (const [cat, keywords] of Object.entries(rules)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

async function createTransaction(args, userId, chatId, currency = 'RUB') {
  const { amount, description, type, bank, goalId } = args;
  const category = args.category || autoCategorize(description);
  const id = createId();

  const txData = {
    userId,
    chatId,
    type,
    amount,
    description,
    categoryId: `cat-${category}`,
    date:       new Date().toISOString(),
    source:     'telegram-bot',
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
  };
  if (bank)   txData.bank   = bank;
  if (goalId) txData.goalId = goalId;

  await db.collection('transactions').doc(id).set(txData);

  if (bank) {
    await db.collection('users').doc(userId).update({
      banks: admin.firestore.FieldValue.arrayUnion(bank),
    }).catch(() => {});
  }

  if (goalId) {
    const goalRef  = db.collection('goals').doc(goalId);
    const goalSnap = await goalRef.get().catch(() => null);
    if (goalSnap?.exists && goalSnap.data().userId === userId) {
      const current = goalSnap.data().currentAmount || 0;
      const delta   = type === 'income' ? amount : -amount;
      await goalRef.update({
        currentAmount: Math.max(0, current + delta),
        updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }

  const emoji    = type === 'income' ? '💰' : '💸';
  const verb     = type === 'income' ? 'Доход' : 'Расход';
  const sym      = CURRENCY_SYMBOLS[currency] || currency;
  const bankStr  = bank ? ` [${bank}]` : '';
  return { ok: true, message: `${emoji} ${verb}: ${description} — ${amount} ${sym} [${category}]${bankStr}` };
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

async function queryTransactions(args, userId, currency = 'RUB') {
  const { type = 'all', limit = 10, bank } = args || {};

  let q = db.collection('transactions').where('userId', '==', userId);
  if (type !== 'all') q = q.where('type', '==', type);
  const fetchLimit = bank ? Math.min(limit * 4, 80) : Math.min(limit, 20);
  q = q.orderBy('date', 'desc').limit(fetchLimit);

  const snap = await q.get();
  let docs = snap.docs;
  if (bank) docs = docs.filter(d => d.data().bank === bank);
  docs = docs.slice(0, Math.min(limit, 20));

  if (!docs.length) return { ok: true, message: 'Нет транзакций.' };

  const sym   = CURRENCY_SYMBOLS[currency] || currency;
  const lines = docs.map(d => {
    const tx        = d.data();
    const emoji     = tx.type === 'income' ? '💰' : '💸';
    const bankLabel = tx.bank ? ` [${tx.bank}]` : '';
    return `${emoji} ${tx.description} — ${tx.amount} ${sym}${bankLabel}`;
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

async function generateImage(args, chatId) {
  const { prompt, style } = args;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const model  = process.env.IMAGE_GEN_MODEL || 'openai/gpt-image-1';

  const fullPrompt = style ? `${prompt}, ${style} style` : prompt;
  console.log('[generate_image] model:', model, '| prompt:', fullPrompt.slice(0, 80));

  const res = await fetch('https://openrouter.ai/api/v1/images/generations', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify({ model, prompt: fullPrompt, n: 1, size: '1024x1024' }),
    signal:  AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error('[generate_image] API error:', res.status, err.slice(0, 200));
    return { ok: false, error: `Ошибка генерации (${res.status}). Попробуй позже.` };
  }

  const data     = await res.json();
  const imageUrl = data.data?.[0]?.url || null;
  const b64      = data.data?.[0]?.b64_json || null;

  if (!imageUrl && !b64) {
    console.error('[generate_image] no image in response:', JSON.stringify(data).slice(0, 200));
    return { ok: false, error: 'Модель не вернула изображение.' };
  }

  if (imageUrl) {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, photo: imageUrl, caption: `🎨 ${prompt}` }),
    });
  } else {
    // b64 response — send as file upload
    const formData = new FormData();
    const blob = new Blob([Buffer.from(b64, 'base64')], { type: 'image/png' });
    formData.append('chat_id', String(chatId));
    formData.append('caption', `🎨 ${prompt}`);
    formData.append('photo', blob, 'image.png');
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: formData });
  }

  return { ok: true, message: '🖼 Картинка отправлена!' };
}

async function getFinanceStats(args, userId, currency = 'RUB') {
  const { period = 'month' } = args || {};
  const now = new Date();

  let startDate = null;
  if (period === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    startDate = new Date(now.getTime() - 7 * 86_400_000);
  } else if (period === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const snap = await db.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('date', 'desc')
    .limit(200)
    .get();

  let totalExpense = 0;
  let totalIncome  = 0;
  const categories = {};
  const byBank     = {};

  for (const doc of snap.docs) {
    const d      = doc.data();
    const txDate = new Date(d.date);
    if (startDate && txDate < startDate) continue;

    if (d.type === 'expense') {
      totalExpense += d.amount || 0;
      const cat = (d.categoryId || 'cat-other').replace('cat-', '');
      categories[cat] = (categories[cat] || 0) + (d.amount || 0);
      if (d.bank) {
        if (!byBank[d.bank]) byBank[d.bank] = { income: 0, expense: 0 };
        byBank[d.bank].expense += d.amount || 0;
      }
    } else if (d.type === 'income') {
      totalIncome += d.amount || 0;
      if (d.bank) {
        if (!byBank[d.bank]) byBank[d.bank] = { income: 0, expense: 0 };
        byBank[d.bank].income += d.amount || 0;
      }
    }
  }

  const periodLabel = { today: 'Сегодня', week: 'За неделю', month: 'За месяц', all: 'За всё время' }[period] || 'За всё время';
  const net = totalIncome - totalExpense;
  const sym = CURRENCY_SYMBOLS[currency] || currency;

  const lines = [
    `📊 ${periodLabel}`,
    `💸 Расходы: ${totalExpense.toFixed(2)} ${sym}`,
    `💰 Доходы:  ${totalIncome.toFixed(2)} ${sym}`,
    `${net >= 0 ? '✅' : '⚠️'} Баланс: ${net >= 0 ? '+' : ''}${net.toFixed(2)} ${sym}`,
  ];

  const catEntries = Object.entries(categories).sort((a, b) => b[1] - a[1]);
  if (catEntries.length) {
    lines.push('', 'По категориям:');
    for (const [cat, amount] of catEntries) {
      lines.push(`  • ${cat}: ${amount.toFixed(2)} ${sym}`);
    }
  }

  const bankEntries = Object.entries(byBank).sort((a, b) => (b[1].expense + b[1].income) - (a[1].expense + a[1].income));
  if (bankEntries.length) {
    lines.push('', 'По банкам:');
    for (const [bk, stats] of bankEntries) {
      const parts = [];
      if (stats.expense > 0) parts.push(`расходы ${stats.expense.toFixed(2)} ${sym}`);
      if (stats.income  > 0) parts.push(`доходы ${stats.income.toFixed(2)} ${sym}`);
      lines.push(`  • ${bk}: ${parts.join(', ')}`);
    }
  }

  return { ok: true, message: lines.join('\n') };
}

async function createAutomation(args, userId, chatId, timezone) {
  const { name, message_text, schedule_type, time, days_of_week, day_of_month } = args;
  const tz = timezone || DEFAULT_TZ;

  if (schedule_type === 'weekly' && (!days_of_week || !days_of_week.length)) {
    return { ok: false, error: 'Для weekly расписания укажи days_of_week (1=Пн, 7=Вс)' };
  }
  if (schedule_type === 'monthly' && !day_of_month) {
    return { ok: false, error: 'Для monthly расписания укажи day_of_month (1-31)' };
  }

  const scheduleData = {
    time,
    daysOfWeek:  schedule_type === 'weekly'  ? (days_of_week || []) : [],
    dayOfMonth:  schedule_type === 'monthly' ? (day_of_month || null) : null,
  };

  const nextRunAt = calculateFirstRun(schedule_type, scheduleData, tz);

  const id = createId();
  await db.collection('automations').doc(id).set({
    userId, chatId, name, messageText: message_text,
    scheduleType: schedule_type, scheduleData,
    nextRunAt:  admin.firestore.Timestamp.fromDate(nextRunAt),
    lastRunAt:  null,
    status:     'active',
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  const offset = getUtcOffsetStr(tz);
  const nextStr = nextRunAt.toLocaleString('ru-RU', {
    timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  const schedStr = formatScheduleRu(schedule_type, scheduleData);

  return {
    ok: true,
    message: `✅ Автоматизация «${name}» создана.\nРасписание: ${schedStr}\nПервый запуск: ${nextStr} (${offset})\nID: ${id}`,
  };
}

async function listAutomations(userId, timezone) {
  const tz = timezone || DEFAULT_TZ;

  const snap = await db.collection('automations')
    .where('userId',  '==', userId)
    .where('status',  '==', 'active')
    .orderBy('nextRunAt', 'asc')
    .limit(20)
    .get();

  if (snap.empty) return { ok: true, message: 'У вас нет активных автоматизаций.' };

  const offset = getUtcOffsetStr(tz);
  const lines  = snap.docs.map(d => {
    const a       = d.data();
    const nextTs  = a.nextRunAt?.toDate?.();
    const nextStr = nextTs ? nextTs.toLocaleString('ru-RU', {
      timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }) : '—';
    const schedStr = formatScheduleRu(a.scheduleType, a.scheduleData || {});
    return `🔁 ${a.name}\n   ${schedStr} | след: ${nextStr} (${offset})\n   ID: ${d.id}`;
  });

  return { ok: true, message: `⚙️ Автоматизации:\n\n${lines.join('\n\n')}` };
}

async function deleteAutomation(args, userId) {
  const { automation_id } = args;
  const ref  = db.collection('automations').doc(automation_id);
  const snap = await ref.get();

  if (!snap.exists || snap.data().userId !== userId) {
    return { ok: false, error: 'Автоматизация не найдена' };
  }
  await ref.update({ status: 'deleted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { ok: true, message: `✅ Автоматизация «${snap.data().name}» удалена` };
}

async function pauseAutomation(args, userId, timezone) {
  const { automation_id, action } = args;
  const tz  = timezone || DEFAULT_TZ;
  const ref  = db.collection('automations').doc(automation_id);
  const snap = await ref.get();

  if (!snap.exists || snap.data().userId !== userId) {
    return { ok: false, error: 'Автоматизация не найдена' };
  }

  const a = snap.data();
  if (action === 'pause') {
    await ref.update({ status: 'paused', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true, message: `⏸ Автоматизация «${a.name}» приостановлена` };
  }

  if (action === 'resume') {
    const nextRunAt = calculateFirstRun(a.scheduleType, a.scheduleData || {}, tz);
    await ref.update({
      status:    'active',
      nextRunAt: admin.firestore.Timestamp.fromDate(nextRunAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const nextStr = nextRunAt.toLocaleString('ru-RU', {
      timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
    return { ok: true, message: `▶️ Автоматизация «${a.name}» возобновлена. Следующий запуск: ${nextStr}` };
  }

  return { ok: false, error: 'action должен быть pause или resume' };
}

async function sendBotMessage(args) {
  const { chat_id, text } = args;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
    signal:  AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));

  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    console.error('[send_message] TG error:', desc);
    return { ok: false, error: `Telegram: ${desc}` };
  }
  return { ok: true, message: `✅ Сообщение отправлено в чат ${chat_id}` };
}

async function forwardBotMessage(args, defaultChatId) {
  const { chat_id, message_id } = args;
  const from_chat_id = args.from_chat_id || String(defaultChatId);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const resp = await fetch(`https://api.telegram.org/bot${token}/forwardMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id, from_chat_id, message_id }),
    signal:  AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));

  if (!data.ok) {
    const desc = data.description || 'Unknown Telegram error';
    console.error('[forward_message] TG error:', desc);
    return { ok: false, error: `Telegram: ${desc}` };
  }
  return { ok: true, message: `✅ Сообщение переслано в чат ${chat_id}` };
}

// ── Banks ─────────────────────────────────────────────────────────────────────

async function setBanks(args, userId) {
  const { banks } = args;
  if (!Array.isArray(banks)) return { ok: false, error: 'banks должен быть массивом' };
  await db.collection('users').doc(userId).update({ banks });
  if (!banks.length) return { ok: true, message: '✅ Список банков очищен.' };
  return { ok: true, message: `✅ Банки сохранены:\n${banks.map(b => `• ${b}`).join('\n')}` };
}

async function getBanks(userId) {
  const doc   = await db.collection('users').doc(userId).get();
  const banks = doc.exists ? (doc.data()?.banks || []) : [];
  if (!banks.length) return { ok: true, message: 'Банки не настроены. Добавь: «Мои банки: Тинькофф, Сбербанк, Наличные»', banks: [] };
  return { ok: true, message: `🏦 Твои банки:\n${banks.map(b => `• ${b}`).join('\n')}`, banks };
}

// ── Goals ─────────────────────────────────────────────────────────────────────

function progressBar(current, target, width = 10) {
  const pct    = Math.min(current / (target || 1), 1);
  const filled = Math.round(pct * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

async function createGoal(args, userId, currency) {
  const { title, targetAmount, deadline, category } = args;
  const sym = CURRENCY_SYMBOLS[currency] || currency;
  const id  = createId();

  await db.collection('goals').doc(id).set({
    userId,
    title,
    targetAmount,
    currentAmount: 0,
    currency,
    deadline:  deadline  || null,
    category:  category  || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  let motivation = '';
  if (deadline) {
    const months = Math.ceil((new Date(deadline) - new Date()) / (1000 * 60 * 60 * 24 * 30));
    if (months > 0) {
      const monthly = Math.ceil(targetAmount / months);
      motivation = `\n\nПри откладывании <b>${monthly} ${sym}/мес</b> достигнешь цели за ${months} мес.`;
    }
  }

  return {
    ok: true,
    message: `🎯 Цель создана: <b>${title}</b>\nЦелевая сумма: ${targetAmount} ${sym}${motivation}\nID: <code>${id}</code>`,
  };
}

async function depositToGoal(args, userId, chatId, currency) {
  const { goalId, amount } = args;
  const sym = CURRENCY_SYMBOLS[currency] || currency;

  const ref  = db.collection('goals').doc(goalId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Цель не найдена' };

  const goal      = snap.data();
  const newAmount = (goal.currentAmount || 0) + amount;
  await ref.update({ currentAmount: newAmount, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  await db.collection('transactions').doc(createId()).set({
    userId, chatId,
    type:        'goal_deposit',
    amount,
    description: `Пополнение: ${goal.title}`,
    categoryId:  'cat-goal',
    goalId,
    date:        new Date().toISOString(),
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  const pct      = Math.min(Math.round(newAmount / goal.targetAmount * 100), 100);
  const bar      = progressBar(newAmount, goal.targetAmount);
  const congrats = pct >= 100 ? '\n\n🎉 Цель достигнута! Поздравляем!' : '';
  return {
    ok: true,
    message: `💰 Пополнение: +${amount} ${sym}\n🎯 <b>${goal.title}</b>\n${bar} ${pct}%\n${newAmount} / ${goal.targetAmount} ${sym}${congrats}`,
  };
}

async function withdrawFromGoal(args, userId, chatId, currency) {
  const { goalId, amount } = args;
  const sym = CURRENCY_SYMBOLS[currency] || currency;

  const ref  = db.collection('goals').doc(goalId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Цель не найдена' };

  const goal    = snap.data();
  const current = goal.currentAmount || 0;
  if (current - amount < 0) return { ok: false, error: `Недостаточно средств. Накоплено: ${current} ${sym}` };

  const newAmount = current - amount;
  await ref.update({ currentAmount: newAmount, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  await db.collection('transactions').doc(createId()).set({
    userId, chatId,
    type:        'goal_withdraw',
    amount,
    description: `Снятие: ${goal.title}`,
    categoryId:  'cat-goal',
    goalId,
    date:        new Date().toISOString(),
    source:      'telegram-bot',
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  const pct = Math.round(newAmount / goal.targetAmount * 100);
  const bar = progressBar(newAmount, goal.targetAmount);
  return {
    ok: true,
    message: `📉 Снятие: -${amount} ${sym}\n🎯 <b>${goal.title}</b>\n${bar} ${pct}%\n${newAmount} / ${goal.targetAmount} ${sym}`,
  };
}

async function listGoals(userId, currency) {
  const sym  = CURRENCY_SYMBOLS[currency] || currency;
  const snap = await db.collection('goals')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  if (snap.empty) return { ok: true, message: 'У тебя нет целей накопления.\n\nСоздай первую: «Хочу накопить на отпуск 50 000»' };

  const lines = snap.docs.map(d => {
    const g    = d.data();
    const cur  = g.currentAmount || 0;
    const pct  = Math.min(Math.round(cur / g.targetAmount * 100), 100);
    const bar  = progressBar(cur, g.targetAmount);
    const dl   = g.deadline
      ? `\n📅 ${new Date(g.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}`
      : '';
    return `🎯 <b>${g.title}</b> — ${cur} / ${g.targetAmount} ${sym} (${pct}%)\n${bar}${dl}\nID: <code>${d.id}</code>`;
  });
  return { ok: true, message: `🎯 <b>Цели накопления:</b>\n\n${lines.join('\n\n')}` };
}

async function deleteGoal(args, userId) {
  const { goalId } = args;
  const ref  = db.collection('goals').doc(goalId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().userId !== userId) return { ok: false, error: 'Цель не найдена' };
  const title = snap.data().title;
  await ref.delete();
  return { ok: true, message: `✅ Цель «${title}» удалена.` };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function executeTool(name, args, userId, chatId, timezone, currency = 'RUB') {
  switch (name) {
    case 'create_reminder':    return createReminder(args, userId, chatId, timezone);
    case 'create_task':        return createTask(args, userId, chatId, timezone);
    case 'create_transaction': return createTransaction(args, userId, chatId, currency);
    case 'query_reminders':    return queryReminders(args, userId, timezone);
    case 'query_tasks':        return queryTasks(args, userId);
    case 'query_transactions': return queryTransactions(args, userId, currency);
    case 'set_timezone':       return setTimezone(args, userId);
    case 'generate_image':     return generateImage(args, chatId);
    case 'get_finance_stats':  return getFinanceStats(args, userId, currency);
    case 'send_message':        return sendBotMessage(args);
    case 'forward_message':     return forwardBotMessage(args, chatId);
    case 'create_automation':   return createAutomation(args, userId, chatId, timezone);
    case 'list_automations':    return listAutomations(userId, timezone);
    case 'delete_automation':   return deleteAutomation(args, userId);
    case 'pause_automation':    return pauseAutomation(args, userId, timezone);
    case 'set_banks':           return setBanks(args, userId);
    case 'get_banks':           return getBanks(userId);
    case 'create_goal':         return createGoal(args, userId, currency);
    case 'deposit_to_goal':     return depositToGoal(args, userId, chatId, currency);
    case 'withdraw_from_goal':  return withdrawFromGoal(args, userId, chatId, currency);
    case 'list_goals':          return listGoals(userId, currency);
    case 'delete_goal':         return deleteGoal(args, userId);
    // search_web is intercepted by the caller
    case 'search_web':          return { ok: false, error: 'SEARCH_WEB_REDIRECT', query: args?.query };
    default:                    return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, getUserTimezone, getUserCurrency, isValidTimezone, getUtcOffsetStr, calculateNextRun };
