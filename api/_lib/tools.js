'use strict';

const { db, admin } = require('./firebaseAdmin');
const txRepo        = require('./repositories/transactions');
const tasksRepo     = require('./repositories/tasks');
const remindersRepo = require('./repositories/reminders');
const { getExchangeRates } = require('./exchangeRates');
const { normalizeTransactionsCurrency, needsFx } = require('./finance/normalizeCurrency');
const { HOME_BUDGET_CURRENCY } = require('./config');
const { hasLockedRub } = require('./finance/lockedAmount');
const { resolveTransactionCurrency } = require('./finance/resolveLegacyCurrency');
const { createFinancialTransaction, TransactionValidationError } = require('./transactions/financialTransaction');
const { FxUnavailableError } = require('./fx');
const { transferGoalFunds, closeGoal, GoalTransferError } = require('./finance/goalTransfer');
const { getActivePlan } = require('./entities/createEntity');
const { checkAndIncrementAiUsage, AI_LIMITS } = require('./aiUsage');
const { exportFinancePdf } = require('./pdf/exportFinancePdf');
const { TOOL_DEFINITIONS } = require('./botTools/definitions');
const { createFinanceTools } = require('./botTools/financeTools');
const { createGoalTools } = require('./botTools/goalTools');
const { createAutomationTools } = require('./botTools/automationTools');
const { createProfileTools } = require('./botTools/profileTools');
const { generateImage } = require('./botTools/imageTools');
const { sendBotMessage, forwardBotMessage } = require('./botTools/messagingTools');

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const DEFAULT_TZ = 'Europe/Warsaw';

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', RUB: '₽', BYN: 'Br', CNY: '¥', GBP: '£', KZT: '₸', TRY: '₺', AED: 'AED', JPY: '¥', CHF: 'CHF' };

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

// The user's CURRENT INPUT currency (user.currency): what a new operation is
// recorded in when the user doesn't name a currency. It is NOT the budget
// currency — budget/analytics are always HOME_BUDGET_CURRENCY (RUB).
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

// ── Tool implementations: reminders and tasks ────────────────────────────────
// Kept next to the time helpers above: these write the `reminders` documents
// the reminder schedulers deliver. The other domains live in ./botTools/.

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

async function queryReminders(args, userId, timezone) {
  const { status = 'pending', limit = 10 } = args || {};
  const tz     = timezone || DEFAULT_TZ;
  const offset = getUtcOffsetStr(tz);

  let reminders;
  try {
    reminders = await remindersRepo.getAllReminders(userId);
  } catch (_) {
    return { ok: true, message: 'Нет напоминаний.' };
  }

  let filtered = remindersRepo.filterByStatus(reminders, status);
  filtered = filtered.slice(0, Math.min(limit, 20));
  if (!filtered.length) return { ok: true, message: 'Нет напоминаний.' };

  const icons = { pending: '⏳', sent: '✅', sending: '🔄', failed: '❌' };
  const lines = filtered.map(r => {
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

  let tasks;
  try {
    tasks = await tasksRepo.getAllTasks(userId);
  } catch (_) {
    return { ok: true, message: 'Нет задач.' };
  }

  if (date) tasks = tasks.filter(t => t.date === date);
  // getAllTasks returns date asc; for display, show date desc (most recent first)
  tasks = tasks.slice().reverse().slice(0, Math.min(limit, 20));

  if (!tasks.length) return { ok: true, message: 'Нет задач.' };

  const lines = tasks.map(t => {
    const icon = t.completed ? '✅' : '📋';
    const tStr = t.time ? ` в ${t.time}` : '';
    return `${icon} ${t.title} — ${t.date}${tStr}`;
  });
  return { ok: true, message: `📋 Задачи:\n${lines.join('\n')}` };
}

// ── Tool implementations: other domains ──────────────────────────────────────
// Built here with this module's dependencies, so a test that substitutes
// firebaseAdmin (or any service) and reloads tools.js rewires all of them.

const toolCtx = {
  db, admin, txRepo, getExchangeRates, normalizeTransactionsCurrency, needsFx,
  HOME_BUDGET_CURRENCY, CURRENCY_SYMBOLS, DEFAULT_TZ, createId,
  hasLockedRub, resolveTransactionCurrency,
  createFinancialTransaction, TransactionValidationError, FxUnavailableError,
  transferGoalFunds, closeGoal, GoalTransferError,
  getActivePlan, checkAndIncrementAiUsage, AI_LIMITS, exportFinancePdf,
  isValidTimezone, getUtcOffsetStr, calculateFirstRun, formatScheduleRu,
};
const { createTransaction, queryTransactions, getFinanceStats, exportFinancePdfTool } = createFinanceTools(toolCtx);
const { createGoal, depositToGoal, withdrawFromGoal, listGoals, deleteGoal } = createGoalTools(toolCtx);
const { createAutomation, listAutomations, deleteAutomation, pauseAutomation } = createAutomationTools(toolCtx);
const { setTimezone, setBanks, getBanks } = createProfileTools(toolCtx);

// ── Dispatcher ────────────────────────────────────────────────────────────────

// `currency` = user.currency = the current INPUT currency. Reads/analytics are
// always in HOME_BUDGET_CURRENCY (RUB) regardless of it.
// messageId: Telegram's message_id for the inbound message that triggered
// this tool call — stable across a webhook redelivery of the SAME update,
// unlike the LLM's own per-completion tool_call id. Only deposit_to_goal /
// withdraw_from_goal use it (as part of their idempotency key); every other
// tool ignores the extra argument.
async function executeTool(name, args, userId, chatId, timezone, currency = 'RUB', messageId) {
  switch (name) {
    case 'create_reminder':    return createReminder(args, userId, chatId, timezone);
    case 'create_task':        return createTask(args, userId, chatId, timezone);
    case 'create_transaction': return createTransaction(args, userId, chatId, currency);
    case 'create_goal':        return createGoal(args, userId, currency);
    case 'query_reminders':    return queryReminders(args, userId, timezone);
    case 'query_tasks':        return queryTasks(args, userId);
    case 'query_transactions': return queryTransactions(args, userId);
    case 'set_timezone':       return setTimezone(args, userId);
    case 'generate_image':     return generateImage(args, chatId);
    case 'get_finance_stats':  return getFinanceStats(args, userId, HOME_BUDGET_CURRENCY);
    case 'send_message':        return sendBotMessage(args);
    case 'forward_message':     return forwardBotMessage(args, chatId);
    case 'create_automation':   return createAutomation(args, userId, chatId, timezone);
    case 'list_automations':    return listAutomations(userId, timezone);
    case 'delete_automation':   return deleteAutomation(args, userId);
    case 'pause_automation':    return pauseAutomation(args, userId, timezone);
    case 'set_banks':           return setBanks(args, userId);
    case 'get_banks':           return getBanks(userId);
    case 'deposit_to_goal':     return depositToGoal(args, userId, chatId, currency, messageId);
    case 'withdraw_from_goal':  return withdrawFromGoal(args, userId, chatId, currency, messageId);
    case 'list_goals':          return listGoals(userId, currency);
    case 'delete_goal':         return deleteGoal(args, userId, chatId, messageId);
    case 'export_finance_pdf':  return exportFinancePdfTool(args, userId, chatId, timezone);
    // search_web is intercepted by the caller
    case 'search_web':          return { ok: false, error: 'SEARCH_WEB_REDIRECT', query: args?.query };
    default:                    return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, getFinanceStats, getUserTimezone, getUserCurrency, isValidTimezone, getUtcOffsetStr, calculateNextRun };