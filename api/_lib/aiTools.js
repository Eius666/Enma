'use strict';

const { db, admin, getUserTimezone } = require('./firebaseAdmin');
const txRepo        = require('./repositories/transactions');
const tasksRepo     = require('./repositories/tasks');
const remindersRepo = require('./repositories/reminders');
const notesRepo     = require('./repositories/notes');
const habitsRepo    = require('./repositories/habits');
const { getExchangeRates } = require('./exchangeRates');
const { normalizeTransactionsCurrency, needsFx } = require('./finance/normalizeCurrency');
const { HOME_BUDGET_CURRENCY } = require('./config');
const { createFinancialTransaction, TransactionValidationError } = require('./transactions/financialTransaction');
const { FxUnavailableError } = require('./fx');

// Budget/analytics currency is fixed (HOME_BUDGET_CURRENCY = RUB). The user's
// own `currency` is the INPUT currency for new operations and is resolved
// inside the shared createFinancialTransaction service.

// ── Constants ──────────────────────────────────────────────────────────────────

const ENTITY_COLLECTION_MAP = {
  task:        'tasks',
  habit:       'habits',
  note:        'notes',
  transaction: 'transactions',
};

const FREE_ENTITY_CONFIG = {
  task:        { field: 'dailyTaskCount',   limit: 5,  windowField: 'date'  },
  habit:       { field: 'habitCount',       limit: 3                        },
  note:        { field: 'noteCount',        limit: 10                       },
  transaction: { field: 'transactionCount', limit: 30, windowField: 'month' },
};

const VALID_CATEGORY_IDS = new Set([
  'p-salary', 'p-freelance', 'p-gift', 'p-other-i',
  'p-groceries', 'p-transport', 'p-entertainment', 'p-health',
  'p-subscriptions', 'p-food', 'p-clothes', 'p-housing', 'p-other-e',
]);

const CATEGORY_NAMES = {
  'p-salary':        'Зарплата',
  'p-freelance':     'Фриланс',
  'p-gift':          'Подарок',
  'p-other-i':       'Другой доход',
  'p-groceries':     'Продукты',
  'p-transport':     'Транспорт',
  'p-entertainment': 'Развлечения',
  'p-health':        'Здоровье',
  'p-subscriptions': 'Подписки',
  'p-food':          'Еда',
  'p-clothes':       'Одежда',
  'p-housing':       'Жильё',
  'p-other-e':       'Другой расход',
};

// ── Date helpers ───────────────────────────────────────────────────────────────

const currentMonth = () => new Date().toISOString().slice(0, 7);
const currentDate  = () => new Date().toISOString().slice(0, 10);

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !isNaN(new Date(s + 'T12:00:00').getTime());
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function makeDocId() {
  const { randomBytes } = require('crypto');
  return `${Date.now()}-${randomBytes(6).toString('hex')}`;
}

// ── Uniform result helpers ─────────────────────────────────────────────────────

function ok(data)              { return { success: true,  data }; }
function err(errorCode, msg)   { return { success: false, errorCode, message: msg }; }

// ── getActivePlan (mirror of [action].js, avoids circular import) ──────────────

async function getActivePlan(userId) {
  try {
    const snap = await db.collection('subscriptions').doc(userId).get();
    if (!snap.exists) return 'free';
    const sub = snap.data();
    if (sub.status !== 'active') return 'free';
    if (sub.plan === 'free' && sub.trialPlan && sub.trialEndDate) {
      if (new Date(sub.trialEndDate) > new Date()) return sub.trialPlan;
    }
    const endMs = sub.endDateMs ?? sub.expiresAt?.toMillis?.() ?? 0;
    if (endMs && endMs < Date.now()) return 'free';
    return sub.plan ?? 'free';
  } catch { return 'free'; }
}

// ── createEntityInFirestore — reuses Free/Pro limit logic ─────────────────────
// Returns { ok: true, id } or { ok: false, code, limit, current }

async function createEntityInFirestore(userId, entityType, data, docId) {
  const collectionName = ENTITY_COLLECTION_MAP[entityType];
  if (!collectionName) throw new Error(`Unknown entity type: ${entityType}`);

  const cfg       = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collectionName).doc(String(docId))
    : db.collection(collectionName).doc();
  const now     = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = { ...data, userId, createdAt: now, updatedAt: now };
  const plan    = await getActivePlan(userId);

  if (plan === 'free' && cfg) {
    const counterRef = db.collection('users').doc(userId).collection('freeUsage').doc('counters');
    const win = cfg.windowField === 'month' ? currentMonth()
              : cfg.windowField === 'date'  ? currentDate()
              : null;
    let limitExceeded = false;
    let currentCount  = 0;

    await db.runTransaction(async tx => {
      const counterSnap = await tx.get(counterRef);
      const counterData = counterSnap.exists ? counterSnap.data() : {};
      const storedWin   = win !== null ? String(counterData[cfg.windowField] ?? '') : null;
      const used        = (storedWin !== null && storedWin !== win) ? 0 : Number(counterData[cfg.field] ?? 0);

      currentCount = used;
      if (used >= cfg.limit) { limitExceeded = true; return; }

      tx.set(entityRef, baseDoc);
      const counterPatch = { userId, [cfg.field]: used + 1, updatedAt: now };
      if (win !== null) counterPatch[cfg.windowField] = win;
      tx.set(counterRef, counterPatch, { merge: true });
    });

    if (limitExceeded) {
      return { ok: false, code: 'LIMIT_REACHED', limit: cfg.limit, current: currentCount };
    }
  } else {
    await entityRef.set(baseDoc);
  }

  return { ok: true, id: entityRef.id };
}

// ── localToUtc — same algorithm as localToUtcForReminder in [action].js ───────

function localToUtc(dateStr, timeStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min]  = timeStr.split(':').map(Number);
  const pseudo    = new Date(Date.UTC(y, m - 1, d, h, min));
  const parts     = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(pseudo);
  const p = {};
  for (const { type, value } of parts) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  const tzAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  return new Date(pseudo.getTime() - (tzAsUtcMs - pseudo.getTime()));
}

// ── findEntityByTitle — fuzzy title search within a single user's collection ───
// Returns { found: doc|null, multiple: bool, error: {errorCode,message}|null }

async function findEntityByTitle(uid, collectionName, titleSearch, maxScan = 100) {
  const snap = await db.collection(collectionName)
    .where('userId', '==', uid)
    .limit(maxScan)
    .get();

  const lc      = titleSearch.toLowerCase().trim();
  const matches = snap.docs.filter(d =>
    (d.data().title ?? '').toLowerCase().includes(lc)
  );

  if (matches.length === 0) return { found: null, multiple: false, error: null };
  if (matches.length > 1) {
    const preview = matches.slice(0, 3).map(d => `"${d.data().title}"`).join(', ');
    return {
      found:    null,
      multiple: true,
      error: {
        errorCode: 'MULTIPLE_MATCHES',
        message:   `Найдено ${matches.length} совпадений: ${preview}. Уточните название.`,
      },
    };
  }
  return { found: matches[0], multiple: false, error: null };
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// ── create_task ───────────────────────────────────────────────────────────────

async function tool_createTask(uid, args, options = {}) {
  const { title, description, date, time, priority } = args;

  if (!title || typeof title !== 'string' || !title.trim())
    return err('VALIDATION_ERROR', 'title обязателен');
  if (title.length > 200)
    return err('VALIDATION_ERROR', 'title слишком длинный (макс 200 символов)');
  if (time && !isValidTime(time))
    return err('VALIDATION_ERROR', 'time должен быть в формате HH:MM (24ч)');
  if (priority && !['high', 'medium', 'low'].includes(priority))
    return err('VALIDATION_ERROR', 'priority должен быть high, medium или low');

  const taskDate     = (date && isValidDate(date)) ? date : currentDate();
  const taskPriority = ['high', 'medium', 'low'].includes(priority) ? priority : 'medium';
  const id           = options.docId || makeDocId();

  const data = {
    id,
    title:       title.trim(),
    description: String(description ?? '').trim().slice(0, 500),
    date:        taskDate,
    time:        time || null,
    priority:    taskPriority,
    completed:   false,
    done:        false,
  };

  const result = await createEntityInFirestore(uid, 'task', data, id);
  if (!result.ok) {
    return err('LIMIT_REACHED', `Лимит задач (${result.limit}/день) исчерпан. Для снятия ограничений — Pro или Premium.`);
  }
  return ok({ id: result.id, title: data.title, date: taskDate, priority: taskPriority });
}

// ── update_task ───────────────────────────────────────────────────────────────

async function tool_updateTask(uid, args) {
  const { taskId, taskTitle, title, description, date, time, priority } = args;

  let docRef;
  if (taskId) {
    const snap = await db.collection('tasks').doc(String(taskId)).get();
    if (!snap.exists || snap.data().userId !== uid)
      return err('NOT_FOUND', `Задача с id "${taskId}" не найдена`);
    docRef = snap.ref;
  } else if (taskTitle) {
    const res = await findEntityByTitle(uid, 'tasks', taskTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Задача "${taskTitle}" не найдена`);
    docRef = res.found.ref;
  } else {
    return err('VALIDATION_ERROR', 'Укажите taskId или taskTitle');
  }

  if (date && !isValidDate(date)) return err('VALIDATION_ERROR', 'date должен быть YYYY-MM-DD');
  if (time !== undefined && time !== null && time !== '' && !isValidTime(time))
    return err('VALIDATION_ERROR', 'time должен быть HH:MM');
  if (priority && !['high', 'medium', 'low'].includes(priority))
    return err('VALIDATION_ERROR', 'priority должен быть high, medium или low');

  const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (title !== undefined)       patch.title       = String(title).trim().slice(0, 200);
  if (description !== undefined) patch.description = String(description).slice(0, 500);
  if (date)                      patch.date        = date;
  if (time !== undefined)        patch.time        = time || null;
  if (priority)                  patch.priority    = priority;

  await docRef.update(patch);
  const updated = Object.keys(patch).filter(k => k !== 'updatedAt');
  return ok({ id: docRef.id, updated });
}

// ── complete_task ─────────────────────────────────────────────────────────────

async function tool_completeTask(uid, args) {
  const { taskId, taskTitle } = args;

  let docRef;
  if (taskId) {
    const snap = await db.collection('tasks').doc(String(taskId)).get();
    if (!snap.exists || snap.data().userId !== uid)
      return err('NOT_FOUND', `Задача с id "${taskId}" не найдена`);
    docRef = snap.ref;
  } else if (taskTitle) {
    const res = await findEntityByTitle(uid, 'tasks', taskTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Задача "${taskTitle}" не найдена`);
    docRef = res.found.ref;
  } else {
    return err('VALIDATION_ERROR', 'Укажите taskId или taskTitle');
  }

  await docRef.update({
    completed: true,
    done:      true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ok({ id: docRef.id, completed: true });
}

// ── create_reminder ───────────────────────────────────────────────────────────

async function tool_createReminder(uid, args, options = {}) {
  const { title, date, time, notes } = args;

  if (!title || typeof title !== 'string' || !title.trim())
    return err('VALIDATION_ERROR', 'title обязателен');
  if (!date || !isValidDate(date))
    return err('VALIDATION_ERROR', 'date обязателен, формат YYYY-MM-DD');
  if (!time || !isValidTime(time))
    return err('VALIDATION_ERROR', 'time обязателен, формат HH:MM (24ч)');

  const tz          = await getUserTimezone(uid);
  const scheduledAt = localToUtc(date, time, tz);

  if (scheduledAt <= new Date())
    return err('VALIDATION_ERROR', `Время ${date} ${time} (${tz}) уже прошло`);

  const [userSnap] = await Promise.all([db.collection('users').doc(uid).get()]);
  const ud     = userSnap.exists ? userSnap.data() : {};
  const chatId = ud.chatId ?? ud.telegramId ?? null;

  const id  = options.docId || makeDocId();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.collection('reminders').doc(id).set({
    id,
    userId:      uid,
    chatId,
    title:       title.trim(),
    notes:       notes ? String(notes).slice(0, 500) : null,
    date,
    time,
    scheduledAt: admin.firestore.Timestamp.fromDate(scheduledAt),
    status:      'pending',
    done:        false,
    language:    ud.language ?? 'ru',
    telegramText:`Напоминание: ${title.trim()}`,
    source:      'ai-chat',
    createdAt:   now,
    updatedAt:   now,
  });

  return ok({ id, title: title.trim(), date, time, scheduledAt: scheduledAt.toISOString() });
}

// ── update_reminder ───────────────────────────────────────────────────────────

async function tool_updateReminder(uid, args) {
  const { reminderId, reminderTitle, title, date, time, notes } = args;

  let docSnap;
  if (reminderId) {
    docSnap = await db.collection('reminders').doc(String(reminderId)).get();
    if (!docSnap.exists || docSnap.data().userId !== uid)
      return err('NOT_FOUND', `Напоминание с id "${reminderId}" не найдено`);
  } else if (reminderTitle) {
    const res = await findEntityByTitle(uid, 'reminders', reminderTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Напоминание "${reminderTitle}" не найдено`);
    docSnap = res.found;
  } else {
    return err('VALIDATION_ERROR', 'Укажите reminderId или reminderTitle');
  }

  if (date && !isValidDate(date)) return err('VALIDATION_ERROR', 'date должен быть YYYY-MM-DD');
  if (time && !isValidTime(time)) return err('VALIDATION_ERROR', 'time должен быть HH:MM');

  const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (title !== undefined) patch.title = String(title).trim().slice(0, 200);
  if (notes !== undefined) patch.notes = notes ? String(notes).slice(0, 500) : null;

  if (date || time) {
    const current  = docSnap.data();
    const newDate  = date || current.date;
    const newTime  = time || current.time;
    const tz       = await getUserTimezone(uid);
    const newSched = localToUtc(newDate, newTime, tz);

    if (newSched <= new Date())
      return err('VALIDATION_ERROR', `Новое время ${newDate} ${newTime} уже прошло`);

    patch.date        = newDate;
    patch.time        = newTime;
    patch.scheduledAt = admin.firestore.Timestamp.fromDate(newSched);
    patch.status      = 'pending';
    patch.done        = false;
  }

  await docSnap.ref.update(patch);
  const updated = Object.keys(patch).filter(k => k !== 'updatedAt');
  return ok({ id: docSnap.id, updated });
}

// ── complete_reminder ─────────────────────────────────────────────────────────

async function tool_completeReminder(uid, args) {
  const { reminderId, reminderTitle } = args;

  let docSnap;
  if (reminderId) {
    docSnap = await db.collection('reminders').doc(String(reminderId)).get();
    if (!docSnap.exists || docSnap.data().userId !== uid)
      return err('NOT_FOUND', `Напоминание с id "${reminderId}" не найдено`);
  } else if (reminderTitle) {
    const res = await findEntityByTitle(uid, 'reminders', reminderTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Напоминание "${reminderTitle}" не найдено`);
    docSnap = res.found;
  } else {
    return err('VALIDATION_ERROR', 'Укажите reminderId или reminderTitle');
  }

  await docSnap.ref.update({
    status:    'done',
    done:      true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ok({ id: docSnap.id, status: 'done' });
}

// ── delete_reminder ───────────────────────────────────────────────────────────

async function tool_deleteReminder(uid, args) {
  const { reminderId, reminderTitle } = args;

  let docSnap;
  if (reminderId) {
    docSnap = await db.collection('reminders').doc(String(reminderId)).get();
    if (!docSnap.exists || docSnap.data().userId !== uid)
      return err('NOT_FOUND', `Напоминание с id "${reminderId}" не найдено`);
  } else if (reminderTitle) {
    const res = await findEntityByTitle(uid, 'reminders', reminderTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Напоминание "${reminderTitle}" не найдено`);
    docSnap = res.found;
  } else {
    return err('VALIDATION_ERROR', 'Укажите reminderId или reminderTitle');
  }

  await docSnap.ref.delete();
  return ok({ id: docSnap.id, deleted: true });
}

// ── create_transaction ────────────────────────────────────────────────────────

async function tool_createTransaction(uid, args, options = {}) {
  const { type, amount, description, date, categoryId, bank } = args;

  if (!['income', 'expense'].includes(type))
    return err('VALIDATION_ERROR', 'type должен быть "income" или "expense"');
  if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount))
    return err('VALIDATION_ERROR', 'amount должен быть положительным числом');
  if (amount > 1_000_000_000)
    return err('VALIDATION_ERROR', 'amount слишком большой');
  if (!description || typeof description !== 'string' || !description.trim())
    return err('VALIDATION_ERROR', 'description обязателен');
  if (categoryId && !VALID_CATEGORY_IDS.has(categoryId))
    return err('VALIDATION_ERROR', `Неверный categoryId. Допустимые: ${[...VALID_CATEGORY_IDS].join(', ')}`);

  const txDate  = (date && isValidDate(date)) ? date : currentDate();
  const catId   = categoryId || (type === 'income' ? 'p-other-i' : 'p-other-e');
  const catName = CATEGORY_NAMES[catId] || catId;
  const id      = options.docId || makeDocId();

  let created;
  try {
    // Money fields (currency precedence explicit → user.currency → RUB,
    // rubAmount, FX snapshot) come from the shared service. The free-plan
    // limit transaction stays here as the persist step.
    created = await createFinancialTransaction({
      uid, docId: id,
      type, amount,
      currency: args.currency,
      description,
      // Real time when the operation is for today; otherwise that day at the current time of day.
      date: (() => { const n = new Date(); const [y, m, d] = txDate.split('-').map(Number); return new Date(y, m - 1, d, n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds()).toISOString(); })(),
      categoryId: catId,
      category: catName,
      bank,
      source: 'ai-chat',
      extra: { id },
    }, {
      persist: (userId, doc, docId) => createEntityInFirestore(userId, 'transaction', doc, docId),
    });
  } catch (e) {
    if (e instanceof FxUnavailableError) {
      return err('FX_UNAVAILABLE', `Не удалось получить надёжный курс ${e.currency} — операция не сохранена. Попробуйте позже или укажите сумму в рублях.`);
    }
    if (e instanceof TransactionValidationError) return err('VALIDATION_ERROR', e.message);
    throw e;
  }

  if (!created.ok) {
    return err('LIMIT_REACHED', `Лимит транзакций (${created.limit}/месяц) исчерпан. Нужен Pro или Premium.`);
  }
  const tx = created.transaction;
  return ok({
    id:          created.id,
    type,
    amount:      tx.amount,
    currency:    tx.currency,
    rubAmount:   tx.rubAmount,
    fxSource:    tx.fx ? tx.fx.source : null,
    description: tx.description,
    date:        txDate,
    category:    catName,
    ...(created.duplicate ? { duplicate: true } : {}),
  });
}

// ── create_habit ──────────────────────────────────────────────────────────────

async function tool_createHabit(uid, args, options = {}) {
  const { title, description, repeatType, repeatDays, color, reminderTime } = args;

  if (!title || typeof title !== 'string' || !title.trim())
    return err('VALIDATION_ERROR', 'title обязателен');
  if (title.length > 200)
    return err('VALIDATION_ERROR', 'title слишком длинный (макс 200 символов)');
  if (reminderTime && !isValidTime(reminderTime))
    return err('VALIDATION_ERROR', 'reminderTime должен быть HH:MM (24ч)');

  const habitRepeatType = ['daily', 'custom'].includes(repeatType) ? repeatType : 'daily';
  const habitRepeatDays = (habitRepeatType === 'custom' && Array.isArray(repeatDays))
    ? repeatDays.filter(d => typeof d === 'number' && d >= 0 && d <= 6)
    : [];
  const habitColor = (typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color))
    ? color
    : '#7B68EE';

  const id   = options.docId || makeDocId();
  const data = {
    id,
    title:          title.trim(),
    description:    String(description ?? '').trim().slice(0, 500),
    color:          habitColor,
    repeatType:     habitRepeatType,
    repeatDays:     habitRepeatDays,
    reminderTime:   reminderTime || null,
    completedDates: [],
    archived:       false,
    streak:         0,
    bestStreak:     0,
  };

  const result = await createEntityInFirestore(uid, 'habit', data, id);
  if (!result.ok) {
    return err('LIMIT_REACHED', `Лимит привычек (${result.limit} всего) исчерпан. Нужен Pro или Premium.`);
  }
  return ok({ id: result.id, title: data.title, repeatType: habitRepeatType });
}

// ── complete_habit_today ──────────────────────────────────────────────────────

async function tool_completeHabitToday(uid, args) {
  const { habitId, habitTitle } = args;
  const todayStr = currentDate();

  let docSnap;
  if (habitId) {
    docSnap = await db.collection('habits').doc(String(habitId)).get();
    if (!docSnap.exists || docSnap.data().userId !== uid)
      return err('NOT_FOUND', `Привычка с id "${habitId}" не найдена`);
  } else if (habitTitle) {
    const res = await findEntityByTitle(uid, 'habits', habitTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Привычка "${habitTitle}" не найдена`);
    docSnap = res.found;
  } else {
    return err('VALIDATION_ERROR', 'Укажите habitId или habitTitle');
  }

  const current        = docSnap.data();
  const completedDates = Array.isArray(current.completedDates) ? current.completedDates : [];

  if (completedDates.includes(todayStr)) {
    return ok({ id: docSnap.id, alreadyCompleted: true, date: todayStr });
  }

  const newDates = [...completedDates, todayStr];
  await docSnap.ref.update({
    completedDates: newDates,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });
  return ok({ id: docSnap.id, completed: true, date: todayStr, totalDays: newDates.length });
}

// ── create_note ───────────────────────────────────────────────────────────────

async function tool_createNote(uid, args, options = {}) {
  const { title, content } = args;

  if (!title || typeof title !== 'string' || !title.trim())
    return err('VALIDATION_ERROR', 'title обязателен');
  if (title.length > 200)
    return err('VALIDATION_ERROR', 'title слишком длинный (макс 200 символов)');

  const id   = options.docId || makeDocId();
  const data = {
    id,
    title:          title.trim(),
    content:        String(content ?? '').slice(0, 10000),
    type:           'text',
    checklistItems: [],
    category:       null,
    pinned:         false,
  };

  const result = await createEntityInFirestore(uid, 'note', data, id);
  if (!result.ok) {
    return err('LIMIT_REACHED', `Лимит заметок (${result.limit} всего) исчерпан. Нужен Pro или Premium.`);
  }
  return ok({ id: result.id, title: data.title });
}

// ── update_note ───────────────────────────────────────────────────────────────

async function tool_updateNote(uid, args) {
  const { noteId, noteTitle, title, content, appendContent } = args;

  let docSnap;
  if (noteId) {
    docSnap = await db.collection('notes').doc(String(noteId)).get();
    if (!docSnap.exists || docSnap.data().userId !== uid)
      return err('NOT_FOUND', `Заметка с id "${noteId}" не найдена`);
  } else if (noteTitle) {
    const res = await findEntityByTitle(uid, 'notes', noteTitle);
    if (res.error) return err(res.error.errorCode, res.error.message);
    if (!res.found) return err('NOT_FOUND', `Заметка "${noteTitle}" не найдена`);
    docSnap = res.found;
  } else {
    return err('VALIDATION_ERROR', 'Укажите noteId или noteTitle');
  }

  const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (title !== undefined) patch.title = String(title).trim().slice(0, 200);

  if (appendContent) {
    const existing = docSnap.data().content ?? '';
    patch.content  = (existing + '\n' + appendContent).trim().slice(0, 10000);
  } else if (content !== undefined) {
    patch.content = String(content).slice(0, 10000);
  }

  await docSnap.ref.update(patch);
  const updated = Object.keys(patch).filter(k => k !== 'updatedAt');
  return ok({ id: docSnap.id, updated });
}

// ── search_tasks ──────────────────────────────────────────────────────────────

async function tool_searchTasks(uid, args) {
  const { status, dateFrom, dateTo, query: q } = args;

  let tasks = await tasksRepo.getAllTasks(uid);

  tasks = tasksRepo.filterByStatus(tasks, status);
  if (dateFrom && isValidDate(dateFrom)) tasks = tasks.filter(t => (t.date || '') >= dateFrom);
  if (dateTo   && isValidDate(dateTo))   tasks = tasks.filter(t => (t.date || '') <= dateTo);
  tasks = tasksRepo.filterByQuery(tasks, q);

  return ok({
    count: tasks.length,
    tasks: tasks.slice(0, 20).map(t => ({
      id:        t.id,
      title:     t.title,
      date:      t.date,
      priority:  t.priority,
      completed: t.completed,
    })),
  });
}

// ── search_reminders ──────────────────────────────────────────────────────────

async function tool_searchReminders(uid, args) {
  const { status, dateFrom, dateTo } = args;

  let reminders = await remindersRepo.getAllReminders(uid);

  reminders = remindersRepo.filterByStatus(reminders, status || 'all');
  reminders = remindersRepo.filterByDateRange(reminders, dateFrom, dateTo);

  return ok({
    count:     reminders.length,
    reminders: reminders.slice(0, 20).map(r => ({
      id:     r.id,
      title:  r.title,
      date:   r.date,
      time:   r.time,
      status: r.status,
    })),
  });
}

// ── search_transactions ───────────────────────────────────────────────────────

async function tool_searchTransactions(uid, args, options = {}) {
  const { dateFrom, dateTo, type, categoryId, query: q } = args;

  let txs = await txRepo.getAllTransactions(uid);

  txs = txRepo.filterByType(txs, type);
  if (categoryId) txs = txs.filter(t => t.categoryId === categoryId);

  if (dateFrom && isValidDate(dateFrom)) {
    const fromIso = new Date(dateFrom + 'T00:00:00').toISOString();
    txs = txs.filter(t => (t.date || '') >= fromIso);
  }
  if (dateTo && isValidDate(dateTo)) {
    const toIso = new Date(dateTo + 'T23:59:59').toISOString();
    txs = txs.filter(t => (t.date || '') <= toIso);
  }
  txs = txRepo.filterByQuery(txs, q);

  // Aggregate in the user's own currency — never sum raw amounts across
  // different transaction currencies, and never guess a legacy record's
  // currency as a blanket default (budget currency is fixed to RUB).
  const currency = HOME_BUDGET_CURRENCY; // budget is always RUB
  const rates = needsFx(txs, currency) ? await getExchangeRates() : null;
  const normalized = normalizeTransactionsCurrency(txs, currency, rates);

  let totalIncome = 0;
  let totalExpense = 0;
  const displayTxs = normalized.ok ? normalized.transactions : txs;
  if (normalized.ok) {
    for (const t of displayTxs) {
      if (t.type === 'income') totalIncome += t.amount;
      if (t.type === 'expense') totalExpense += t.amount;
    }
  }

  return ok({
    count:        txs.length,
    currency,
    currencyDataOk: normalized.ok,
    totalIncome:  Math.round(totalIncome  * 100) / 100,
    totalExpense: Math.round(totalExpense * 100) / 100,
    balance:      Math.round((totalIncome - totalExpense) * 100) / 100,
    transactions: displayTxs.slice(0, 15).map(t => ({
      type:        t.type,
      // Each transaction keeps its OWN real currency — never implied to be
      // in the user's display currency without conversion.
      amount:      t.originalAmount ?? t.amount,
      currency:    t.originalCurrency ?? t.currency ?? 'RUB',
      // Budget value in RUB (locked rubAmount for v2). The model must use THIS
      // — never add up `amount` across different currencies.
      amountRub:   normalized.ok ? Math.round(t.amount * 100) / 100 : undefined,
      description: t.description,
      category:    t.category,
      date:        (t.date || '').slice(0, 10),
    })),
  });
}

// ── search_notes ──────────────────────────────────────────────────────────────

async function tool_searchNotes(uid, args) {
  const { query: q } = args;

  let notes = await notesRepo.getAllNotes(uid);
  notes = notesRepo.filterByQuery(notes, q);

  return ok({
    count: notes.length,
    notes: notes.slice(0, 10).map(n => ({
      id:      n.id,
      title:   n.title,
      preview: String(n.content ?? '').slice(0, 200),
    })),
  });
}

// ── get_habits ────────────────────────────────────────────────────────────────

async function tool_getHabits(uid, args) {
  const { includeArchived } = args;

  let habits = await habitsRepo.getAllHabits(uid);
  if (!includeArchived) habits = habitsRepo.filterActive(habits);

  const todayStr = currentDate();

  return ok({
    count:  habits.length,
    habits: habits.map(h => ({
      id:             h.id,
      title:          h.title,
      repeatType:     h.repeatType,
      completedToday: habitsRepo.isCompletedToday(h, todayStr),
      streak:         h.streak,
      archived:       h.archived,
    })),
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

const HANDLERS = {
  create_task:          tool_createTask,
  update_task:          tool_updateTask,
  complete_task:        tool_completeTask,
  create_reminder:      tool_createReminder,
  update_reminder:      tool_updateReminder,
  complete_reminder:    tool_completeReminder,
  delete_reminder:      tool_deleteReminder,
  create_transaction:   tool_createTransaction,
  create_habit:         tool_createHabit,
  complete_habit_today: tool_completeHabitToday,
  create_note:          tool_createNote,
  update_note:          tool_updateNote,
  search_tasks:         tool_searchTasks,
  search_reminders:     tool_searchReminders,
  search_transactions:  tool_searchTransactions,
  search_notes:         tool_searchNotes,
  get_habits:           tool_getHabits,
};

async function executeTool(uid, toolName, args, options = {}) {
  const handler = HANDLERS[toolName];
  if (!handler) {
    return err('UNKNOWN_TOOL', `Неизвестный инструмент: ${toolName}`);
  }
  try {
    return await handler(uid, args ?? {}, options);
  } catch (e) {
    console.error(`[AI_TOOL] ${toolName} uid=${uid} error:`, e.message);
    return err('INTERNAL_ERROR', 'Внутренняя ошибка при выполнении инструмента');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (OpenAI function calling format)
// ══════════════════════════════════════════════════════════════════════════════

const VALID_CATEGORIES_LIST = [...VALID_CATEGORY_IDS];

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name:        'create_task',
      description: 'Создаёт новую задачу. Используй когда пользователь просит добавить, создать или запланировать задачу.',
      parameters:  {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Название задачи. Обязательно.' },
          description: { type: 'string', description: 'Описание задачи (необязательно).' },
          date:        { type: 'string', description: 'Дата YYYY-MM-DD. По умолчанию — сегодня.' },
          time:        { type: 'string', description: 'Время HH:MM 24ч (необязательно).' },
          priority:    { type: 'string', enum: ['high', 'medium', 'low'], description: 'Приоритет. По умолчанию medium.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'update_task',
      description: 'Обновляет существующую задачу. Можно изменить дату, время, приоритет, описание или название.',
      parameters:  {
        type: 'object',
        properties: {
          taskId:      { type: 'string', description: 'ID задачи (если известен).' },
          taskTitle:   { type: 'string', description: 'Название задачи для поиска (если ID неизвестен).' },
          title:       { type: 'string', description: 'Новое название.' },
          description: { type: 'string', description: 'Новое описание.' },
          date:        { type: 'string', description: 'Новая дата YYYY-MM-DD.' },
          time:        { type: 'string', description: 'Новое время HH:MM или пустая строка для удаления.' },
          priority:    { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'complete_task',
      description: 'Отмечает задачу как выполненную.',
      parameters:  {
        type: 'object',
        properties: {
          taskId:    { type: 'string', description: 'ID задачи.' },
          taskTitle: { type: 'string', description: 'Название задачи для поиска.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_reminder',
      description: 'Создаёт напоминание. ОБЯЗАТЕЛЬНО нужна точная дата и время. Если пользователь не указал время — уточни перед созданием.',
      parameters:  {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Текст напоминания. Обязательно.' },
          date:  { type: 'string', description: 'Дата YYYY-MM-DD. Обязательно.' },
          time:  { type: 'string', description: 'Время HH:MM 24ч. Обязательно.' },
          notes: { type: 'string', description: 'Дополнительная заметка (необязательно).' },
        },
        required: ['title', 'date', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'update_reminder',
      description: 'Обновляет существующее напоминание (дату, время или текст).',
      parameters:  {
        type: 'object',
        properties: {
          reminderId:    { type: 'string', description: 'ID напоминания.' },
          reminderTitle: { type: 'string', description: 'Текст напоминания для поиска.' },
          title:         { type: 'string', description: 'Новый текст.' },
          date:          { type: 'string', description: 'Новая дата YYYY-MM-DD.' },
          time:          { type: 'string', description: 'Новое время HH:MM.' },
          notes:         { type: 'string', description: 'Новая заметка.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'complete_reminder',
      description: 'Отмечает напоминание как выполненное (закрывает его).',
      parameters:  {
        type: 'object',
        properties: {
          reminderId:    { type: 'string', description: 'ID напоминания.' },
          reminderTitle: { type: 'string', description: 'Текст напоминания для поиска.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'delete_reminder',
      description: 'Удаляет напоминание полностью.',
      parameters:  {
        type: 'object',
        properties: {
          reminderId:    { type: 'string', description: 'ID напоминания.' },
          reminderTitle: { type: 'string', description: 'Текст напоминания для поиска.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_transaction',
      description: 'Записывает финансовую операцию (доход или расход). Используй для любых фраз про деньги, траты, покупки, зарплату.',
      parameters:  {
        type: 'object',
        properties: {
          type:        { type: 'string', enum: ['income', 'expense'], description: 'income — доход, expense — расход. Обязательно.' },
          amount:      { type: 'number', description: 'Сумма (положительное число). Обязательно.' },
          currency:    { type: 'string', enum: ['RUB', 'USD', 'EUR', 'CNY', 'BYN', 'GBP', 'KZT', 'TRY', 'AED', 'JPY', 'CHF'], description: 'Валюта операции, ТОЛЬКО если пользователь явно её назвал ("$5000", "80 юаней" → CNY, "1000 руб" → RUB). Если не названа — не указывай: сервер подставит текущую валюту ввода пользователя.' },
          description: { type: 'string', description: 'Описание операции. Обязательно.' },
          date:        { type: 'string', description: 'Дата YYYY-MM-DD. По умолчанию сегодня.' },
          categoryId:  {
            type:        'string',
            enum:        VALID_CATEGORIES_LIST,
            description: 'ID категории. Расходы: p-groceries, p-transport, p-entertainment, p-health, p-subscriptions, p-food, p-clothes, p-housing, p-other-e. Доходы: p-salary, p-freelance, p-gift, p-other-i.',
          },
          bank:        { type: 'string', description: 'Банк или метод оплаты (необязательно).' },
        },
        required: ['type', 'amount', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_habit',
      description: 'Создаёт новую привычку для ежедневного трекинга.',
      parameters:  {
        type: 'object',
        properties: {
          title:        { type: 'string', description: 'Название привычки. Обязательно.' },
          description:  { type: 'string', description: 'Описание (необязательно).' },
          repeatType:   { type: 'string', enum: ['daily', 'custom'], description: 'daily — каждый день, custom — выбранные дни.' },
          repeatDays:   { type: 'array', items: { type: 'number', minimum: 0, maximum: 6 }, description: 'Дни недели (0=Пн…6=Вс). Только для custom.' },
          reminderTime: { type: 'string', description: 'Время напоминания HH:MM (необязательно).' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'complete_habit_today',
      description: 'Отмечает привычку выполненной на сегодня.',
      parameters:  {
        type: 'object',
        properties: {
          habitId:    { type: 'string', description: 'ID привычки.' },
          habitTitle: { type: 'string', description: 'Название привычки для поиска.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'create_note',
      description: 'Создаёт новую заметку.',
      parameters:  {
        type: 'object',
        properties: {
          title:   { type: 'string', description: 'Название заметки. Обязательно.' },
          content: { type: 'string', description: 'Содержимое заметки.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'update_note',
      description: 'Обновляет существующую заметку. Для добавления к тексту без замены — используй appendContent.',
      parameters:  {
        type: 'object',
        properties: {
          noteId:        { type: 'string', description: 'ID заметки.' },
          noteTitle:     { type: 'string', description: 'Название заметки для поиска.' },
          title:         { type: 'string', description: 'Новое название (необязательно).' },
          content:       { type: 'string', description: 'Полное новое содержимое (заменяет старое).' },
          appendContent: { type: 'string', description: 'Текст для добавления к существующему содержимому.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'search_tasks',
      description: 'Поиск и фильтрация задач пользователя.',
      parameters:  {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: ['pending', 'completed', 'all'], description: 'Фильтр по статусу.' },
          dateFrom: { type: 'string', description: 'Начало диапазона YYYY-MM-DD.' },
          dateTo:   { type: 'string', description: 'Конец диапазона YYYY-MM-DD.' },
          query:    { type: 'string', description: 'Поиск по тексту.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'search_reminders',
      description: 'Поиск напоминаний пользователя.',
      parameters:  {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: ['pending', 'done', 'all'], description: 'Фильтр по статусу.' },
          dateFrom: { type: 'string', description: 'Начало диапазона YYYY-MM-DD.' },
          dateTo:   { type: 'string', description: 'Конец диапазона YYYY-MM-DD.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'search_transactions',
      description: 'Поиск и агрегация транзакций. Используй когда нужна статистика за период, поиск конкретных трат, или сумма расходов по категории.',
      parameters:  {
        type: 'object',
        properties: {
          dateFrom:   { type: 'string', description: 'Начало периода YYYY-MM-DD.' },
          dateTo:     { type: 'string', description: 'Конец периода YYYY-MM-DD.' },
          type:       { type: 'string', enum: ['income', 'expense'], description: 'Фильтр по типу.' },
          categoryId: { type: 'string', description: 'Фильтр по категории.' },
          query:      { type: 'string', description: 'Поиск по описанию.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'search_notes',
      description: 'Поиск по заметкам пользователя.',
      parameters:  {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name:        'get_habits',
      description: 'Возвращает список привычек пользователя с информацией о выполнении сегодня.',
      parameters:  {
        type: 'object',
        properties: {
          includeArchived: { type: 'boolean', description: 'Включить архивированные. По умолчанию false.' },
        },
        required: [],
      },
    },
  },
];

module.exports = { TOOL_DEFINITIONS, executeTool, createEntityInFirestore };
