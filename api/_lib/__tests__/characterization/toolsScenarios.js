'use strict';

// Scenarios for the api/_lib/tools characterization test: every tool that
// executeTool dispatches, plus the helpers other modules import from tools
// (the Telegram webhook, the reminder cron, the LLM chat loop). All data is
// synthetic; the clock is pinned to 2026-10-15T09:30:00Z (a Thursday).

const crypto = require('node:crypto');
const { ts, NOW } = require('../../../__tests__/support/characterization');

const DAY = 86400000;
const tool = (name, args, o = {}) => ({
  call: (m) => m.executeTool(name, args, o.userId ?? 'u1', o.chatId ?? 555, 'timezone' in o ? o.timezone : 'Europe/Moscow', o.currency, o.messageId),
});
const fn = (name, ...args) => ({ call: (m) => m[name](...args) });
const TG_OK = { match: /\/(sendMessage|forwardMessage|sendPhoto|sendDocument)$/, json: { ok: true, result: { message_id: 9 } } };
const RATES = { match: /exchangerate-api\.com/, json: { rates: { RUB: 1, USD: 0.0125, EUR: 0.0107 } } };
const premium = { 'subscriptions/u1': { userId: 'u1', plan: 'premium', status: 'active', endDateMs: NOW + 20 * DAY } };
const G1 = { userId: 'u1', title: 'Laptop', targetAmount: 1000, currentAmount: 100, currentAmountRub: 100, currency: 'RUB', createdAt: ts('2026-10-01T00:00:00Z') };

const scenarios = [];
const add = (name, def) => scenarios.push({ name, ...def });

// ── reminders & tasks ───────────────────────────────────────────────────────
add('create_reminder: relative minutes', { steps: [tool('create_reminder', { title: 'Stretch', relative_time: 'через 30 минут' })] });
add('create_reminder: tomorrow at a time, default zone', { steps: [tool('create_reminder', { title: 'Call', relative_time: 'завтра в 10:00', description: 'mom' }, { timezone: undefined })] });
add('create_reminder: unparseable time', { steps: [tool('create_reminder', { title: 'X', relative_time: 'когда-нибудь' })] });
add('create_reminder: a time in the past', { steps: [tool('create_reminder', { title: 'X', relative_time: 'сегодня в 08:00' })] });
add('create_reminder: hours and an explicit clock time', {
  steps: [tool('create_reminder', { title: 'A', relative_time: 'через 2 часа' }), tool('create_reminder', { title: 'B', relative_time: 'в 18:45' }, { timezone: 'Asia/Almaty' })],
});
add('create_task: explicit date and a time-only expression', { steps: [tool('create_task', { title: 'Dentist', date: '2026-10-20', relative_time: 'в 14:00', category: 'health' })] });
add('create_task: tomorrow at a time', { steps: [tool('create_task', { title: 'Gym', relative_time: 'завтра в 9:30' })] });
add('create_task: date without a time', { steps: [tool('create_task', { title: 'Report', date: '2026-10-21' })] });
add('create_task: neither date nor time', { steps: [tool('create_task', { title: 'Someday' }, { timezone: 'America/New_York' })] });
add('create_task: a past time gets no reminder', { steps: [tool('create_task', { title: 'Old', date: '2026-10-10', relative_time: 'в 08:00' })] });
add('query_reminders: none', { steps: [tool('query_reminders', {})] });
add('query_reminders: by status and limit', {
  seed: {
    'reminders/r1': { userId: 'u1', title: 'One', status: 'pending', scheduledAt: ts('2026-10-16T07:00:00Z') },
    'reminders/r2': { userId: 'u1', title: 'Two', status: 'sent', scheduledAt: ts('2026-10-14T07:00:00Z') },
    'reminders/r3': { userId: 'u1', title: 'Three', status: 'failed' },
    'reminders/r4': { userId: 'u2', title: 'Other', status: 'pending', scheduledAt: ts('2026-10-16T07:00:00Z') },
    'reminders/r5': { userId: 'u1', title: 'Five', status: 'pending', scheduledAt: ts('2026-10-15T12:00:00Z') },
  },
  steps: [tool('query_reminders', {}), tool('query_reminders', { status: 'sent' }), tool('query_reminders', { status: 'pending', limit: 1 }), tool('query_reminders', undefined, { timezone: undefined })],
});
add('query_tasks: none', { steps: [tool('query_tasks', {})] });
add('query_tasks: date filter and limit', {
  seed: {
    'tasks/t1': { userId: 'u1', title: 'A', date: '2026-10-14', time: '10:00', completed: true },
    'tasks/t2': { userId: 'u1', title: 'B', date: '2026-10-15' },
    'tasks/t3': { userId: 'u1', title: 'C', date: '2026-10-16', done: true },
    'tasks/t4': { userId: 'u2', title: 'Other', date: '2026-10-15' },
  },
  steps: [tool('query_tasks', {}), tool('query_tasks', { date: '2026-10-15' }), tool('query_tasks', { limit: 1 })],
});

// ── finance ─────────────────────────────────────────────────────────────────
add('create_transaction: an expense is categorised automatically', { seed: { 'users/u1': { currency: 'RUB' } }, steps: [tool('create_transaction', { amount: 250, description: 'Кофе с собой', type: 'expense' })] });
add('create_transaction: income to a bank account', {
  seed: { 'users/u1': { currency: 'RUB', banks: ['Сбер'] } },
  steps: [tool('create_transaction', { amount: 50000, description: 'Зарплата', type: 'income', bank: 'Тинькофф', category: 'salary' })],
});
add('create_transaction: linked to an own goal', {
  seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 },
  steps: [tool('create_transaction', { amount: 30, description: 'В копилку', type: 'expense', goalId: 'g1' }), tool('create_transaction', { amount: 500, description: 'Бонус', type: 'income', goalId: 'g1' })],
});
add('create_transaction: another user\'s goal is not touched', {
  seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': { ...G1, userId: 'u2' } },
  steps: [tool('create_transaction', { amount: 30, description: 'x', type: 'expense', goalId: 'g1' })],
});
add('create_transaction: invalid amount', { steps: [tool('create_transaction', { amount: -1, description: 'x', type: 'expense' })] });
add('create_transaction: invalid type', { steps: [tool('create_transaction', { amount: 1, description: 'x', type: 'gift' })] });
add('create_transaction: a foreign currency without rates', { seed: { 'users/u1': { currency: 'RUB' } }, steps: [tool('create_transaction', { amount: 10, description: 'Coffee', type: 'expense', currency: 'USD' })] });
add('create_transaction: the user input currency without rates', { seed: { 'users/u1': { currency: 'EUR' } }, steps: [tool('create_transaction', { amount: 10, description: 'Metro', type: 'expense' }, { currency: 'EUR' })] });
add('query_transactions: none', { steps: [tool('query_transactions', {})] });
const TXS = {
  'transactions/a': { userId: 'u1', type: 'expense', amount: 300, currency: 'RUB', rubAmount: 300, schemaVersion: 2, description: 'Food', date: '2026-10-14', categoryId: 'cat-food', bank: 'Сбер' },
  'transactions/b': { userId: 'u1', type: 'income', amount: 100, currency: 'USD', rubAmount: 8000, schemaVersion: 2, fx: { rateToRub: 80, source: 'bank_average' }, description: 'Freelance', date: '2026-10-10', bank: 'Тинькофф' },
  'transactions/c': { userId: 'u1', type: 'goal_deposit', amount: 50, description: 'Goal', date: '2026-10-12' },
  'transactions/c2': { userId: 'u1', type: 'goal_withdraw', amount: 20, currency: 'RUB', description: 'Goal back', date: '2026-10-13' },
  'transactions/d': { userId: 'u1', type: 'expense', amount: 1200, description: 'Legacy rent', date: '2026-09-28', categoryId: 'cat-bills', source: 'web-app' },
  'transactions/e': { userId: 'u1', type: 'income', amount: 70000, currency: 'RUB', rubAmount: 70000, schemaVersion: 2, description: 'Salary', date: '2026-10-01', categoryId: 'cat-salary', bank: 'Сбер' },
  'transactions/f': { userId: 'u1', type: 'expense', amount: 99, currency: 'RUB', rubAmount: 99, schemaVersion: 2, description: 'Today snack', date: '2026-10-15', categoryId: 'cat-food' },
  'transactions/z': { userId: 'u2', type: 'expense', amount: 1, description: 'Other user', date: '2026-10-14' },
};
add('query_transactions: types, banks and currencies', {
  seed: TXS,
  steps: [tool('query_transactions', {}), tool('query_transactions', { type: 'income' }), tool('query_transactions', { bank: 'Сбер', limit: 1 }), tool('query_transactions', { type: 'expense', limit: 50 })],
});
const { 'transactions/d': _legacy, ...rest } = TXS;
const TXS_RESOLVABLE = { ...rest, 'transactions/c': { ...TXS['transactions/c'], currency: 'RUB' } };
add('get_finance_stats: an unresolvable legacy row blocks the totals', { fetch: [RATES], seed: TXS, steps: [tool('get_finance_stats', { period: 'month' })] });
add('get_finance_stats: periods in the budget currency', {
  fetch: [RATES],
  seed: TXS_RESOLVABLE,
  steps: ['month', 'week', 'today', 'all', 'decade'].map(period => tool('get_finance_stats', { period })),
});
add('get_finance_stats: default period', { fetch: [RATES], seed: TXS_RESOLVABLE, steps: [tool('get_finance_stats', undefined)] });
add('get_finance_stats: locked ruble values need no rates', { seed: TXS_RESOLVABLE, steps: [tool('get_finance_stats', { period: 'month' })] });
add('get_finance_stats: legacy foreign rows need rates', {
  fetch: [RATES],
  seed: { 'transactions/x': { userId: 'u1', type: 'expense', amount: 10, currency: 'USD', description: 'Old USD', date: '2026-10-02', source: 'telegram-bot' }, 'transactions/y': { userId: 'u1', type: 'income', amount: 1000, currency: 'RUB', description: 'RUB', date: '2026-10-03' } },
  steps: [tool('get_finance_stats', { period: 'month' })],
});
add('get_finance_stats: legacy foreign rows without rates', {
  seed: { 'transactions/x': { userId: 'u1', type: 'expense', amount: 10, currency: 'USD', description: 'Old USD', date: '2026-10-02', source: 'telegram-bot' } },
  steps: [tool('get_finance_stats', { period: 'month' })],
});
add('get_finance_stats: a storage failure', { failures: [{ collection: 'transactions', message: 'down' }], steps: [tool('get_finance_stats', { period: 'month' })] });
add('getFinanceStats: direct call with another target currency', { fetch: [RATES], seed: TXS_RESOLVABLE, steps: [fn('getFinanceStats', { period: 'all' }, 'u1', 'USD'), fn('getFinanceStats', {}, 'u1')] });
add('export_finance_pdf: free plan', { steps: [tool('export_finance_pdf', { period: 'month' })] });
add('export_finance_pdf: premium, sent as a document', {
  seed: { ...premium, 'transactions/a': TXS['transactions/a'], 'transactions/e': TXS['transactions/e'] },
  fetch: [TG_OK],
  steps: [tool('export_finance_pdf', { period: 'month' })],
});
add('export_finance_pdf: Telegram rejects the document', {
  seed: { ...premium, 'transactions/a': TXS['transactions/a'] },
  fetch: [{ match: /sendDocument$/, status: 400, json: { ok: false, description: 'Bad Request: file is too big' } }],
  steps: [tool('export_finance_pdf', { period: 'month' })],
});
add('export_finance_pdf: the upload fails', { seed: premium, fetch: [{ match: /sendDocument$/, throw: 'socket hang up' }], steps: [tool('export_finance_pdf', { period: 'week' })] });
add('export_finance_pdf: an invalid period', { seed: premium, steps: [tool('export_finance_pdf', { period: 'decade' })] });

// ── goals ───────────────────────────────────────────────────────────────────
add('create_goal: an explicit currency and a deadline', { steps: [tool('create_goal', { title: 'Trip', targetAmount: 2000, deadline: '2027-04-15', category: 'travel', currency: 'USD' })] });
add('create_goal: the user currency, no deadline', { steps: [tool('create_goal', { title: 'Bike', targetAmount: 30000, currency: 'XYZ' }, { currency: 'EUR' })] });
add('create_goal: a past deadline', { steps: [tool('create_goal', { title: 'Late', targetAmount: 10, deadline: '2026-01-01' })] });
add('deposit_to_goal: unknown goal', { seed: { 'users/u1': { currency: 'RUB' } }, steps: [tool('deposit_to_goal', { goalId: 'nope', amount: 10 }, { messageId: 7 })] });
add('deposit_to_goal: a redelivered message is applied once', {
  seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 },
  steps: [tool('deposit_to_goal', { goalId: 'g1', amount: 100 }, { messageId: 7 }), tool('deposit_to_goal', { goalId: 'g1', amount: 100 }, { messageId: 7 })],
});
add('deposit_to_goal: reaching the target', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('deposit_to_goal', { goalId: 'g1', amount: 900 }, { messageId: 8 })] });
add('deposit_to_goal: going past the target', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('deposit_to_goal', { goalId: 'g1', amount: 950 }, { messageId: 16 })] });
add('deposit_to_goal: without a message id', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('deposit_to_goal', { goalId: 'g1', amount: 5 })] });
add('deposit_to_goal: an invalid amount', { seed: { 'goals/g1': G1 }, steps: [tool('deposit_to_goal', { goalId: 'g1', amount: 0 }, { messageId: 9 })] });
add('withdraw_from_goal: more than saved', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('withdraw_from_goal', { goalId: 'g1', amount: 500 }, { messageId: 10 })] });
add('withdraw_from_goal: a withdrawal', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('withdraw_from_goal', { goalId: 'g1', amount: 40 }, { messageId: 11 })] });
add('withdraw_from_goal: unknown goal', { steps: [tool('withdraw_from_goal', { goalId: 'nope', amount: 1 }, { messageId: 12 })] });
add('list_goals: none', { steps: [tool('list_goals', {})] });
add('list_goals: progress and deadlines', {
  seed: { 'goals/g1': G1, 'goals/g2': { userId: 'u1', title: 'Car', targetAmount: 500000, currentAmount: 600000, deadline: '2027-06-01' }, 'goals/g3': { userId: 'u2', title: 'Other', targetAmount: 1 } },
  steps: [tool('list_goals', {}, { currency: 'USD' })],
});
add('delete_goal: unknown goal', { steps: [tool('delete_goal', { goalId: 'nope' }, { messageId: 13 })] });
add('delete_goal: another user\'s goal', { seed: { 'goals/g1': { ...G1, userId: 'u2' } }, steps: [tool('delete_goal', { goalId: 'g1' }, { messageId: 13 })] });
add('delete_goal: the balance is returned', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': G1 }, steps: [tool('delete_goal', { goalId: 'g1' }, { messageId: 14 })] });
add('delete_goal: an empty goal', { seed: { 'users/u1': { currency: 'RUB' }, 'goals/g1': { ...G1, currentAmount: 0, currentAmountRub: 0 } }, steps: [tool('delete_goal', { goalId: 'g1' }, { messageId: 15 })] });

// ── automations ─────────────────────────────────────────────────────────────
add('create_automation: weekly needs days', { steps: [tool('create_automation', { name: 'W', message_text: 'm', schedule_type: 'weekly', time: '09:00' })] });
add('create_automation: monthly needs a day', { steps: [tool('create_automation', { name: 'M', message_text: 'm', schedule_type: 'monthly', time: '09:00' })] });
add('create_automation: daily, weekly and monthly schedules', {
  steps: [
    tool('create_automation', { name: 'Daily', message_text: 'Water', schedule_type: 'daily', time: '08:00' }),
    tool('create_automation', { name: 'Daily late', message_text: 'Sleep', schedule_type: 'daily', time: '23:00' }),
    tool('create_automation', { name: 'Weekly', message_text: 'Plan', schedule_type: 'weekly', time: '10:00', days_of_week: [4, 1] }),
    tool('create_automation', { name: 'Monthly', message_text: 'Rent', schedule_type: 'monthly', time: '12:00', day_of_month: 31 }),
    tool('create_automation', { name: 'Odd', message_text: 'x', schedule_type: 'yearly', time: '07:00' }, { timezone: undefined }),
    tool('create_automation', { name: 'Daily with days', message_text: 'x', schedule_type: 'daily', time: '07:00', days_of_week: [1, 2], day_of_month: 5 }),
  ],
});
const AUTOS = {
  'automations/a1': { userId: 'u1', name: 'Water', status: 'active', scheduleType: 'daily', scheduleData: { time: '08:00' }, nextRunAt: ts('2026-10-16T05:00:00Z') },
  'automations/a2': { userId: 'u1', name: 'Plan', status: 'paused', scheduleType: 'weekly', scheduleData: { time: '10:00', daysOfWeek: [1] }, nextRunAt: ts('2026-10-19T07:00:00Z') },
  'automations/a3': { userId: 'u2', name: 'Other', status: 'active', scheduleType: 'daily', scheduleData: { time: '08:00' } },
  'automations/a4': { userId: 'u1', name: 'Rent', status: 'active', scheduleType: 'monthly', scheduleData: { time: '12:00', dayOfMonth: 1 } },
};
add('list_automations: none', { steps: [tool('list_automations', {})] });
add('list_automations: active ones', { seed: AUTOS, steps: [tool('list_automations', {})] });
add('delete_automation: unknown, foreign and own', {
  seed: AUTOS,
  steps: [tool('delete_automation', { automation_id: 'nope' }), tool('delete_automation', { automation_id: 'a3' }), tool('delete_automation', { automation_id: 'a1' })],
});
add('pause_automation: pause, resume, bad action and unknown', {
  seed: AUTOS,
  steps: [
    tool('pause_automation', { automation_id: 'a1', action: 'pause' }),
    tool('pause_automation', { automation_id: 'a2', action: 'resume' }),
    tool('pause_automation', { automation_id: 'a1', action: 'stop' }),
    tool('pause_automation', { automation_id: 'a3', action: 'pause' }),
  ],
});

// ── messaging, media, profile ───────────────────────────────────────────────
add('send_message: no bot token', { env: { TELEGRAM_BOT_TOKEN: null }, steps: [tool('send_message', { chat_id: 1, text: 'x' })] });
add('send_message: delivered and refused', {
  fetch: [{ match: (u, b) => /sendMessage$/.test(u) && b.chat_id === 2, json: { ok: false, description: 'Forbidden' } }, { match: (u, b) => /sendMessage$/.test(u) && b.chat_id === 3, json: {} }, TG_OK],
  steps: [tool('send_message', { chat_id: 1, text: '<b>hi</b>' }), tool('send_message', { chat_id: 2, text: 'x' }), tool('send_message', { chat_id: 3, text: 'x' })],
});
add('forward_message: default source chat and refusal', {
  fetch: [{ match: (u, b) => /forwardMessage$/.test(u) && b.chat_id === 2, json: { ok: false } }, TG_OK],
  steps: [tool('forward_message', { chat_id: 1, message_id: 5 }), tool('forward_message', { chat_id: 2, message_id: 5, from_chat_id: '77' })],
});
add('forward_message: no bot token', { env: { TELEGRAM_BOT_TOKEN: null }, steps: [tool('forward_message', { chat_id: 1, message_id: 5 })] });
add('generate_image: provider error', {
  env: { OPENROUTER_API_KEY: 'test-openrouter-key' },
  fetch: [{ match: /images\/generations$/, status: 500, json: { error: 'busy' } }],
  steps: [tool('generate_image', { prompt: 'a cat', style: 'watercolor' })],
});
add('generate_image: a URL result is sent as a photo', {
  env: { OPENROUTER_API_KEY: 'test-openrouter-key', IMAGE_GEN_MODEL: 'test/model' },
  fetch: [{ match: /images\/generations$/, json: { data: [{ url: 'https://img.example.test/cat.png' }] } }, TG_OK],
  steps: [tool('generate_image', { prompt: 'a cat' })],
});
add('generate_image: a base64 result is uploaded', {
  env: { OPENROUTER_API_KEY: 'test-openrouter-key' },
  fetch: [{ match: /images\/generations$/, json: { data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] } }, TG_OK],
  steps: [tool('generate_image', { prompt: 'a dog' })],
});
add('generate_image: no image in the answer', {
  fetch: [{ match: /images\/generations$/, json: { data: [] } }],
  steps: [tool('generate_image', { prompt: 'nothing' })],
});
add('set_timezone: invalid and valid', {
  seed: { 'users/u1': { timezone: 'Europe/Moscow' } },
  steps: [tool('set_timezone', { timezone: 'Mars/Olympus' }), tool('set_timezone', { timezone: 'Asia/Tokyo' })],
});
add('set_banks and get_banks', {
  seed: { 'users/u1': { currency: 'RUB' } },
  steps: [tool('get_banks', {}), tool('set_banks', { banks: 'Сбер' }), tool('set_banks', { banks: ['Сбер', 'Наличные'] }), tool('get_banks', {}), tool('set_banks', { banks: [] })],
});
add('get_banks: no profile document', { steps: [tool('get_banks', {}, { userId: 'ghost' })] });
add('search_web is handed back to the caller', { steps: [tool('search_web', { query: 'weather' }), tool('search_web', undefined)] });
add('an unknown tool', { steps: [tool('teleport', {})] });
add('query tools show at most 20 rows', {
  seed: () => {
    const seed = {};
    for (let i = 0; i < 22; i++) {
      const d = `2026-10-${String(1 + i).padStart(2, '0')}`;
      seed[`tasks/t${i}`] = { userId: 'u1', title: `T${i}`, date: d };
      seed[`reminders/r${i}`] = { userId: 'u1', title: `R${i}`, status: 'pending', scheduledAt: ts(`${d}T10:00:00Z`) };
      seed[`transactions/x${i}`] = { userId: 'u1', type: 'expense', amount: i + 1, currency: 'RUB', rubAmount: i + 1, schemaVersion: 2, description: `X${i}`, date: d };
    }
    return seed;
  },
  steps: [tool('query_tasks', { limit: 100 }), tool('query_reminders', { limit: 100 }), tool('query_transactions', { limit: 100 })],
});

// ── exported helpers (used by the webhook, the cron and the chat loop) ─────
add('getUserTimezone and getUserCurrency', {
  seed: { 'users/a': { timezone: 'Asia/Almaty', currency: 'KZT' }, 'users/b': { timezone: 'Nowhere/Land' }, 'users/c': {} },
  steps: ['a', 'b', 'c', 'missing'].flatMap(u => [fn('getUserTimezone', u), fn('getUserCurrency', u)]),
});
add('getUserTimezone: a storage failure falls back', { failures: [{ collection: 'users' }], steps: [fn('getUserTimezone', 'a'), fn('getUserCurrency', 'a')] });
add('isValidTimezone and getUtcOffsetStr', {
  steps: ['Europe/Moscow', 'America/New_York', 'Asia/Kolkata', 'UTC', 'Bad/Zone', '', undefined].flatMap(tz => [fn('isValidTimezone', tz), fn('getUtcOffsetStr', tz)]),
});
add('calculateNextRun: schedules across zones and month ends', {
  steps: [
    fn('calculateNextRun', 'daily', { time: '08:00' }, new Date('2026-10-15T05:00:00Z'), 'Europe/Moscow'),
    fn('calculateNextRun', 'daily', { time: '23:30' }, new Date('2026-10-24T21:30:00Z'), 'Europe/Warsaw'),
    fn('calculateNextRun', 'weekly', { time: '10:00', daysOfWeek: [5, 1] }, new Date('2026-10-15T07:00:00Z'), 'Europe/Moscow'),
    fn('calculateNextRun', 'weekly', { time: '10:00', daysOfWeek: [4] }, new Date('2026-10-15T07:00:00Z'), 'Europe/Moscow'),
    fn('calculateNextRun', 'weekly', { time: '10:00' }, new Date('2026-10-15T07:00:00Z'), undefined),
    fn('calculateNextRun', 'monthly', { time: '12:00', dayOfMonth: 31 }, new Date('2026-01-31T09:00:00Z'), 'Europe/Moscow'),
    fn('calculateNextRun', 'monthly', { time: '12:00', dayOfMonth: 15 }, new Date('2026-12-15T09:00:00Z'), 'America/New_York'),
    fn('calculateNextRun', 'monthly', { time: '12:00' }, new Date('2026-10-01T09:00:00Z'), 'Asia/Tokyo'),
    fn('calculateNextRun', 'yearly', { time: '12:00' }, new Date('2026-10-01T09:00:00Z'), 'Asia/Tokyo'),
  ],
});
add('tool definitions are unchanged', {
  steps: [{
    call: (m) => ({
      names: m.TOOL_DEFINITIONS.map(t => t.function?.name || t.name),
      sha256: crypto.createHash('sha256').update(JSON.stringify(m.TOOL_DEFINITIONS)).digest('hex'),
    }),
  }],
});
add('the module export surface is unchanged', { steps: [{ call: (m) => Object.keys(m).sort() }] });

module.exports = { scenarios };
