'use strict';

// Scenarios for the api/ai/[action] characterization test. Every route action
// appears at least once; branches that change what the caller or the database
// sees (validation, authorisation, not-found, success, upstream failure) are
// covered per action. All data is synthetic.

const { ts, NOW, ADMIN_KEY, miniAppInitData, loginWidgetPayload, totp, partnerToken } = require('../../../__tests__/support/characterization');

const DAY = 86400000;
const U = (uid = 'u1') => ({ authorization: `Bearer tok-${uid}` });
const A = { 'x-admin-key': ADMIN_KEY };
const post = (action, body, headers = {}) => ({ action, body, headers });
const user = (action, body, uid) => post(action, body, U(uid));
const adm = (action, body) => post(action, body, A);
const iso = (ms) => new Date(ms).toISOString();
const TG_OK = { match: /\/sendMessage$/, json: { ok: true, result: { message_id: 1 } } };
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SMOKE_UID = '2MhVQ2hZD0cgDcYzxlHzhumml9l1';

const premium = (uid = 'u1') => ({ [`subscriptions/${uid}`]: { userId: uid, plan: 'premium', status: 'active', endDateMs: NOW + 20 * DAY } });
const pro = (uid = 'u1') => ({ [`subscriptions/${uid}`]: { userId: uid, plan: 'pro', status: 'active', endDateMs: NOW + 20 * DAY } });

const scenarios = [];
const add = (name, def) => scenarios.push({ name, ...def });

// ── router ──────────────────────────────────────────────────────────────────
add('router: GET is 405', { request: { action: 'adminStats', method: 'GET', headers: A } });
add('router: unknown action is 404', { request: user('chat', {}) });
add('router: missing action is 404', { request: { action: undefined, body: {} } });
add('router: a repeated action parameter is 404', { request: { action: ['adminStats'], headers: A, body: {} } });
add('router: prototype names are 404', { steps: ['constructor', '__proto__', 'toString'].map(a => adm(a, {})) });
add('router: an admin handler failure answers 500 with the message', {
  failures: [{ collection: 'payments', message: 'payments backend down' }],
  request: adm('adminPayments', {}),
});
add('router: a user handler failure answers 500 without details', {
  failures: [{ collection: 'users', message: 'users backend down' }],
  request: user('referralInfo', {}),
});
add('router: an upstream 503 is passed on as 503', {
  failures: [{ collection: 'aiUsage', message: 'overloaded', statusCode: 503 }],
  request: adm('adminAiUsage', {}),
});
add('router: admin actions are refused when no admin key is configured', {
  env: { ADMIN_API_KEY: null },
  steps: [adm('adminStats', {}), adm('adminVerifyOtp', {}), adm('adminNotesDiagnostic', { uid: 'u1' })],
});
add('router: an invalid ID token is 401', { request: { action: 'goalCreate', body: { title: 'x', targetAmount: 1 }, headers: { authorization: 'Bearer forged' } } });
add('router: a non-Bearer authorization header is 401', { request: { action: 'goalCreate', body: {}, headers: { authorization: 'Basic abc' } } });

// ── entityCreate ────────────────────────────────────────────────────────────
add('entityCreate: missing data is 400', { request: user('entityCreate', { entityType: 'note' }) });
add('entityCreate: data must be an object', { request: user('entityCreate', { entityType: 'note', data: 'text' }) });
add('entityCreate: unknown entity type is 400', { request: user('entityCreate', { entityType: 'spaceship', data: {} }) });
add('entityCreate: a note is created for a free user', {
  request: user('entityCreate', { entityType: 'note', docId: 'n1', data: { title: 'N', content: 'c', userId: 'someone-else' } }),
});
add('entityCreate: a note without docId gets a generated id', {
  request: user('entityCreate', { entityType: 'note', data: { title: 'N', content: 'c' } }),
});
add('entityCreate: the free note limit is enforced', {
  seed: () => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`notes/n${i}`, { userId: 'u1', title: `n${i}`, content: '' }])),
  request: user('entityCreate', { entityType: 'note', docId: 'n10', data: { title: 'eleventh', content: '' } }),
});
add('entityCreate: premium users are not limited', {
  seed: () => ({ ...premium(), ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`notes/n${i}`, { userId: 'u1', title: `n${i}`, content: '' }])) }),
  request: user('entityCreate', { entityType: 'note', docId: 'n10', data: { title: 'eleventh', content: '' } }),
});
add('entityCreate: a habit is created', {
  request: user('entityCreate', { entityType: 'habit', docId: 'h1', data: { title: 'Run', repeatType: 'daily', reminderTime: '07:00' } }),
});
add('entityCreate: a task with a time schedules a reminder in the client zone', {
  seed: { 'users/u1': { chatId: 555, timezone: 'Europe/Moscow' } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', timeZone: 'Asia/Almaty', data: { id: 't1', title: 'Call', date: '2026-10-16', time: '20:00' } }),
});
add('entityCreate: a task falls back to the stored zone', {
  seed: { 'users/u1': { telegramId: 556, timezone: 'Europe/Moscow' } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', data: { id: 't1', title: 'Call', date: '2026-10-16', time: '20:00' } }),
});
add('entityCreate: a task without any zone gets no reminder', {
  seed: { 'users/u1': { chatId: 555 } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', data: { id: 't1', title: 'Call', date: '2026-10-16', time: '20:00' } }),
});
add('entityCreate: a task in the past gets no reminder', {
  seed: { 'users/u1': { chatId: 555 } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', timeZone: 'UTC', data: { id: 't1', title: 'Old', date: '2026-10-14', time: '08:00' } }),
});
add('entityCreate: an existing reminder for the task is not duplicated', {
  seed: { 'users/u1': { chatId: 555 }, 'reminders/task-t1': { status: 'pending', userId: 'u1' } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', timeZone: 'UTC', data: { id: 't1', title: 'Again', date: '2026-10-16', time: '08:00' } }),
});
add('entityCreate: a task without Telegram link gets no reminder', {
  seed: { 'users/u1': { name: 'x' } },
  request: user('entityCreate', { entityType: 'task', docId: 't1', timeZone: 'UTC', data: { id: 't1', title: 'Call', date: '2026-10-16', time: '20:00' } }),
});
add('entityCreate: a task without time is created without reminder', {
  request: user('entityCreate', { entityType: 'task', docId: 't2', data: { id: 't2', title: 'Someday', date: '2026-10-16' } }),
});
add('entityCreate: the free daily task limit is enforced', {
  seed: { 'users/u1/freeUsage/counters': { dailyTaskCount: 5, date: '2026-10-15' } },
  request: user('entityCreate', { entityType: 'task', docId: 't3', data: { id: 't3', title: 'Sixth', date: '2026-10-15' } }),
});
add('entityCreate: a RUB expense is created with server-side money fields', {
  seed: { 'users/u1': { currency: 'RUB' } },
  request: user('entityCreate', { entityType: 'transaction', docId: 'tx1', data: { type: 'expense', amount: 500, currency: 'RUB', description: 'Coffee', date: '2026-10-15', category: 'food', rubAmount: 1, fx: { rateToRub: 99 }, schemaVersion: 99 } }),
});
add('entityCreate: an invalid transaction is 400', {
  request: user('entityCreate', { entityType: 'transaction', docId: 'tx1', data: { type: 'expense', amount: -5, currency: 'RUB' } }),
});
add('entityCreate: a wrong transaction type is 400', {
  request: user('entityCreate', { entityType: 'transaction', docId: 'tx1', data: { type: 'gift', amount: 5, currency: 'RUB' } }),
});
add('entityCreate: the free monthly transaction limit is enforced', {
  seed: { 'users/u1': { currency: 'RUB' }, 'users/u1/freeUsage/counters': { transactionCount: 30, month: '2026-10' } },
  request: user('entityCreate', { entityType: 'transaction', docId: 'tx31', data: { type: 'income', amount: 5, currency: 'RUB', date: '2026-10-15' } }),
});
add('entityCreate: a foreign-currency transaction without rates is 503', {
  seed: { 'users/u1': { currency: 'RUB' } },
  request: user('entityCreate', { entityType: 'transaction', docId: 'tx1', data: { type: 'expense', amount: 10, currency: 'USD', date: '2026-10-15' } }),
});
add('entityCreate: a storage failure is 500', {
  failures: [{ collection: 'notes', message: 'notes backend down' }],
  request: user('entityCreate', { entityType: 'note', docId: 'n1', data: { title: 'N', content: 'c' } }),
});

// ── transactionUpdate ───────────────────────────────────────────────────────
const TX1 = { userId: 'u1', type: 'expense', amount: 500, currency: 'RUB', rubAmount: 500, schemaVersion: 2, description: 'a', date: '2026-10-10', category: 'food' };
add('transactionUpdate: missing id is 400', { request: user('transactionUpdate', { patch: {} }) });
add('transactionUpdate: patch must be an object', { request: user('transactionUpdate', { id: 'tx1', patch: 'x' }) });
add('transactionUpdate: unknown transaction is 404', { request: user('transactionUpdate', { id: 'nope', patch: { description: 'b' } }) });
add('transactionUpdate: another user\'s transaction is 404', {
  seed: { 'transactions/tx1': { ...TX1, userId: 'u2' } },
  request: user('transactionUpdate', { id: 'tx1', patch: { description: 'b' } }),
});
add('transactionUpdate: description edit', {
  seed: { 'transactions/tx1': TX1, 'users/u1': { currency: 'RUB' } },
  request: user('transactionUpdate', { id: 'tx1', patch: { description: 'b' } }),
});
add('transactionUpdate: amount edit recomputes money fields', {
  seed: { 'transactions/tx1': TX1, 'users/u1': { currency: 'RUB' } },
  request: user('transactionUpdate', { id: 'tx1', patch: { amount: 750 } }),
});
add('transactionUpdate: invalid amount is 400', {
  seed: { 'transactions/tx1': TX1 },
  request: user('transactionUpdate', { id: 'tx1', patch: { amount: -1 } }),
});
add('transactionUpdate: an empty patch changes nothing', {
  seed: { 'transactions/tx1': TX1 },
  request: user('transactionUpdate', { id: 'tx1', patch: {} }),
});

// ── exportFinancePdf ────────────────────────────────────────────────────────
add('exportFinancePdf: free plan is 429', { request: user('exportFinancePdf', { period: 'month' }) });
add('exportFinancePdf: pro plan is 429', { seed: pro(), request: user('exportFinancePdf', { period: 'month' }) });
add('exportFinancePdf: monthly allowance used up is 429', {
  seed: { ...premium(), 'aiUsage/u1': { userId: 'u1', month: '2026-10', textRequests: 0, imageRequests: 0, pdfReports: 10 } },
  request: user('exportFinancePdf', { period: 'month' }),
});
add('exportFinancePdf: invalid period is 400', { seed: premium(), request: user('exportFinancePdf', { period: 'decade' }) });
add('exportFinancePdf: invalid custom range is 400', { seed: premium(), request: user('exportFinancePdf', { period: 'custom', dateFrom: '2026-10-10', dateTo: '2026-10-01' }) });
add('exportFinancePdf: premium gets a PDF', {
  seed: {
    ...premium(),
    'users/u1': { currency: 'RUB', displayName: 'Test' },
    'transactions/t1': { userId: 'u1', type: 'income', amount: 1000, currency: 'RUB', rubAmount: 1000, schemaVersion: 2, date: '2026-10-02', category: 'p-salary', description: 'Salary' },
    'transactions/t2': { userId: 'u1', type: 'expense', amount: 250, currency: 'RUB', rubAmount: 250, schemaVersion: 2, date: '2026-10-05', category: 'p-groceries', description: 'Food' },
  },
  request: user('exportFinancePdf', { period: 'month' }),
});

// ── goals ───────────────────────────────────────────────────────────────────
const G1 = { userId: 'u1', title: 'Laptop', targetAmount: 1000, currentAmount: 100, currentAmountRub: 100, currency: 'RUB' };
add('goalCreate: empty title is 400', { request: user('goalCreate', { title: '  ', targetAmount: 10 }) });
add('goalCreate: long title is 400', { request: user('goalCreate', { title: 'x'.repeat(121), targetAmount: 10 }) });
add('goalCreate: non-positive amount is 400', { request: user('goalCreate', { title: 'Car', targetAmount: 0 }) });
add('goalCreate: too large amount is 400', { request: user('goalCreate', { title: 'Car', targetAmount: 2_000_000_000 }) });
add('goalCreate: malformed deadline is 400', { request: user('goalCreate', { title: 'Car', targetAmount: 10, deadline: '15.10.2026' }) });
add('goalCreate: a goal is created', { request: user('goalCreate', { title: '  Car ', targetAmount: 1234.567, deadline: '2027-01-01' }) });
add('goalCreate: an empty deadline is stored as null', { request: user('goalCreate', { title: 'Car', targetAmount: 10, deadline: '' }) });
add('goalAdjust: invalid direction is 400', { request: user('goalAdjust', { id: 'g1', amount: 5, direction: 'steal', operationId: 'op1' }) });
add('goalAdjust: missing operationId is 400', { request: user('goalAdjust', { id: 'g1', amount: 5, direction: 'deposit' }) });
add('goalAdjust: unknown goal is 404', { seed: { 'users/u1': { currency: 'RUB' } }, request: user('goalAdjust', { id: 'nope', amount: 5, direction: 'deposit', operationId: 'op1' }) });
add('goalAdjust: deposit, then the same operation again is a duplicate', {
  seed: { 'goals/g1': G1, 'users/u1': { currency: 'RUB' } },
  steps: [
    user('goalAdjust', { id: 'g1', amount: 50, direction: 'deposit', operationId: ' op1 ' }),
    user('goalAdjust', { id: 'g1', amount: 50, direction: 'deposit', operationId: 'op1' }),
  ],
});
add('goalAdjust: withdrawing more than the goal holds is 400', {
  seed: { 'goals/g1': G1, 'users/u1': { currency: 'RUB' } },
  request: user('goalAdjust', { id: 'g1', amount: 500, direction: 'withdraw', operationId: 'op2' }),
});
add('goalAdjust: withdrawal', {
  seed: { 'goals/g1': G1, 'users/u1': { currency: 'RUB' } },
  request: user('goalAdjust', { id: 'g1', amount: 40, direction: 'withdraw', operationId: 'op3' }),
});
add('goalAdjust: another user\'s goal is 404', {
  seed: { 'goals/g1': { ...G1, userId: 'u2' }, 'users/u1': { currency: 'RUB' } },
  request: user('goalAdjust', { id: 'g1', amount: 5, direction: 'deposit', operationId: 'op4' }),
});
add('goalDelete: missing id is 400', { request: user('goalDelete', { operationId: 'x' }) });
add('goalDelete: missing operationId is 400', { request: user('goalDelete', { id: 'g1' }) });
add('goalDelete: unknown goal is 404', { request: user('goalDelete', { id: 'nope', operationId: 'del1' }) });
add('goalDelete: the remaining balance is returned and the goal closed', {
  seed: { 'goals/g1': G1, 'users/u1': { currency: 'RUB' } },
  request: user('goalDelete', { id: 'g1', operationId: 'del1' }),
});
add('goalDelete: an empty goal is closed', {
  seed: { 'goals/g1': { ...G1, currentAmount: 0, currentAmountRub: 0 }, 'users/u1': { currency: 'RUB' } },
  request: user('goalDelete', { id: 'g1', operationId: 'del2' }),
});

// ── partners ────────────────────────────────────────────────────────────────
const widget = (over = {}) => loginWidgetPayload({ id: '777', first_name: 'Pat', last_name: 'Ner', username: 'patner', auth_date: String(Math.floor(NOW / 1000) - 60), ...over });
add('partnerLogin: a bad signature is 401', { request: post('partnerLogin', { ...widget(), first_name: 'Mallory' }) });
add('partnerLogin: a stale login is 401', { request: post('partnerLogin', widget({ auth_date: String(Math.floor(NOW / 1000) - 2 * 86400) })) });
add('partnerLogin: an unsigned body is 401', { request: post('partnerLogin', undefined) });
add('partnerLogin: a new partner signs in, sees the dashboard and creates links', {
  steps: [
    post('partnerLogin', widget()),
    (h) => post('partnerMe', {}, { authorization: `Bearer ${h[0].body.json.token}` }),
    (h) => post('partnerLink', { platform: 'YT' }, { authorization: `Bearer ${h[0].body.json.token}` }),
    (h) => post('partnerLink', { platform: 'unknown' }, { authorization: `Bearer ${h[0].body.json.token}` }),
    (h) => post('partnerMe', {}, { authorization: `Bearer ${h[0].body.json.token}` }),
  ],
});
add('partnerLogin: an existing partner gets the same code', {
  seed: { 'referrers/ABC123': { code: 'ABC123', name: 'Old Name', telegramId: 777, status: 'paused' } },
  request: post('partnerLogin', widget()),
});
add('partnerLogin: more than 10 attempts a minute from one address are throttled', {
  steps: Array.from({ length: 11 }, () => post('partnerLogin', { id: '1', hash: 'x' })),
});
add('partnerLogin: a missing session secret is a 500', { env: { PARTNER_SESSION_SECRET: null }, request: post('partnerLogin', widget()) });
add('partnerMe: a session for an unknown partner is 404', {
  request: post('partnerMe', {}, { authorization: `Bearer ${partnerToken('NOPE42', NOW + DAY)}` }),
});
add('partnerMe: an expired session is 401', {
  seed: { 'referrers/ABC123': { code: 'ABC123', name: 'P' } },
  request: post('partnerMe', {}, { authorization: `Bearer ${partnerToken('ABC123', NOW - 1)}` }),
});
add('partnerMe: a tampered session is 401', {
  request: post('partnerMe', {}, { authorization: `Bearer ${partnerToken('ABC123', NOW + DAY).slice(0, -2)}xx` }),
});
add('partnerMe: summary with links and earnings', {
  seed: {
    'referrers/ABC123': { code: 'ABC123', name: 'P', clicks: 5, registrations: 2, totalEarned: 300, pendingPayout: 100, paidOut: 200, commissionPercent: 25 },
    'referrers/ABC123/links/yt': { platform: 'yt', clicks: 3 },
    'referralEarnings/e1': { referrerId: 'ABC123', amount: 1000, commission: 250, status: 'pending', platform: 'yt', createdAt: ts('2026-10-01T10:00:00Z') },
    'referralEarnings/e2': { referrerId: 'ABC123', amount: 200, commission: 50, status: 'cancelled', createdAt: ts('2026-10-02T10:00:00Z') },
    'referralEarnings/e3': { referrerId: 'OTHER', amount: 1, commission: 1, status: 'pending' },
  },
  request: post('partnerMe', {}, { authorization: `Bearer ${partnerToken('ABC123', NOW + DAY)}` }),
});
add('partnerLink: no session is 401', { request: post('partnerLink', { platform: 'tg' }) });
add('partnerBotInfo: without a bot token the configured name is used', { env: { TELEGRAM_BOT_TOKEN: null }, request: post('partnerBotInfo', {}) });
add('partnerBotInfo: the live name is fetched once and cached', {
  env: { TELEGRAM_BOT_USERNAME: 'ConfiguredBot' },
  fetch: [{ match: /\/getMe$/, json: { ok: true, result: { username: 'LiveBot' } } }],
  steps: [post('partnerBotInfo', {}), post('partnerBotInfo', {})],
});
add('partnerBotInfo: the cache expires after five minutes', {
  fetch: [{ match: /\/getMe$/, json: { ok: true, result: { username: 'LiveBot' } } }],
  steps: [post('partnerBotInfo', {}), { ...post('partnerBotInfo', {}), advanceMs: 5 * 60 * 1000 + 1 }],
});
add('partnerBotInfo: a Telegram failure falls back to the configured name', {
  fetch: [{ match: /\/getMe$/, throw: 'getaddrinfo ENOTFOUND' }],
  request: post('partnerBotInfo', {}),
});
add('partnerBotInfo: an unexpected Telegram answer falls back', {
  fetch: [{ match: /\/getMe$/, json: { ok: false, description: 'Unauthorized' } }],
  request: post('partnerBotInfo', {}),
});

// ── referral ────────────────────────────────────────────────────────────────
add('referralValidate: missing code is 400', { request: user('referralValidate', {}) });
add('referralValidate: an active partner code is accepted', {
  seed: { 'referrers/BLOGGER': { status: 'active', discountPercent: 15, commissionPercent: 25, name: 'Blogger' } },
  request: user('referralValidate', { code: ' blogger ' }),
});
add('referralValidate: partner code defaults', {
  seed: { 'referrers/BLOGGER': { status: 'active' } },
  request: user('referralValidate', { code: 'BLOGGER' }),
});
add('referralValidate: an inactive partner code falls through to user codes', {
  seed: { 'referrers/BLOGGER': { status: 'paused' } },
  request: user('referralValidate', { code: 'BLOGGER' }),
});
add('referralValidate: a user already attributed to another partner falls through', {
  seed: { 'referrers/BLOGGER': { status: 'active' }, 'users/u1': { referredByInfluencer: 'OTHER' } },
  request: user('referralValidate', { code: 'BLOGGER' }),
});
add('referralValidate: a user referral code is accepted', {
  seed: { 'users/u2': { referralCode: 'ABCD1234' } },
  request: user('referralValidate', { code: 'ABCD1234' }),
});
add('referralValidate: own code is refused', {
  seed: { 'users/u1': { referralCode: 'SELF0001' } },
  request: user('referralValidate', { code: 'SELF0001' }),
});
add('referralValidate: an already referred user is refused', {
  seed: { 'users/u1': { referredBy: 'u9' }, 'users/u2': { referralCode: 'ABCD1234' } },
  request: user('referralValidate', { code: 'ABCD1234' }),
});
add('referralInfo: a referral code is generated on first use', {
  seed: { 'users/u1': { chatId: 555 }, 'referrals/r1': { referrerId: 'u1' }, 'referrals/r2': { referrerId: 'u3' } },
  request: user('referralInfo', {}),
});
add('referralInfo: an existing code and balances are returned', {
  env: { TELEGRAM_BOT_USERNAME: 'SomeBot' },
  seed: { 'users/u1': { referralCode: 'KEEP0001', referralBalance: 150, totalReferralEarnedRub: 300, referredBy: 'u7' } },
  request: user('referralInfo', {}),
});
add('referralInfo: a user without a profile document', { request: user('referralInfo', {}) });
add('referralInfo: an empty stored code is regenerated', {
  seed: { 'users/u1': { referralCode: '', referralLink: 'https://t.me/x?start=ref_OLD' } },
  request: user('referralInfo', {}),
});

// ── referralPayout (admin key) ─────────────────────────────────────────────
const REF = {
  'referrers/ABC123': { code: 'ABC123', pendingPayout: 300, paidOut: 0 },
  'referralEarnings/e1': { referrerId: 'ABC123', status: 'pending', commission: 100, createdAt: ts('2026-10-01T00:00:00Z') },
  'referralEarnings/e2': { referrerId: 'ABC123', status: 'pending', commission: 250, createdAt: ts('2026-10-02T00:00:00Z') },
  'referralEarnings/e3': { referrerId: 'ABC123', status: 'paid', commission: 50, createdAt: ts('2026-09-02T00:00:00Z') },
};
add('referralPayout: a wrong admin key is 403', { request: post('referralPayout', { listOnly: true }, { 'x-admin-key': 'nope' }) });
add('referralPayout: list referrers with pending payouts', {
  seed: { ...REF, 'referrers/ZERO': { pendingPayout: 0 } },
  request: adm('referralPayout', { listOnly: true, minAmount: '1' }),
});
add('referralPayout: missing fields are 400', { request: adm('referralPayout', { referrerId: 'abc123' }) });
add('referralPayout: unknown referrer is 404', { request: adm('referralPayout', { referrerId: 'nope', amount: 10 }) });
add('referralPayout: nothing pending is 400', { seed: { 'referrers/ABC123': { pendingPayout: 0 } }, request: adm('referralPayout', { referrerId: 'abc123', amount: 10 }) });
add('referralPayout: pays earnings oldest first up to the amount', { seed: REF, request: adm('referralPayout', { referrerId: 'abc123', amount: 200 }) });
add('referralPayout: the amount is capped at the pending balance', { seed: REF, request: adm('referralPayout', { referrerId: 'ABC123', amount: 1000 }) });
add('referralPayout: an amount covering several earnings pays them all', {
  seed: { ...REF, 'referrers/ABC123': { code: 'ABC123', pendingPayout: 400, paidOut: 10 } },
  request: adm('referralPayout', { referrerId: 'ABC123', amount: 349.9995 }),
});

// ── admin OTP ───────────────────────────────────────────────────────────────
add('adminVerifyOtp: without a configured secret no OTP is required', { request: adm('adminVerifyOtp', { token: '123456' }) });
add('adminVerifyOtp: a token is required when configured', { env: { ADMIN_TOTP_SECRET: TOTP_SECRET }, request: adm('adminVerifyOtp', {}) });
add('adminVerifyOtp: the current code is accepted', { env: { ADMIN_TOTP_SECRET: TOTP_SECRET }, request: adm('adminVerifyOtp', { token: totp(TOTP_SECRET, NOW) }) });
add('adminVerifyOtp: the previous and next codes are accepted (clock skew)', {
  env: { ADMIN_TOTP_SECRET: TOTP_SECRET },
  steps: [adm('adminVerifyOtp', { token: totp(TOTP_SECRET, NOW, -1) }), adm('adminVerifyOtp', { token: totp(TOTP_SECRET, NOW, 1) })],
});
add('adminVerifyOtp: an older code is refused', { env: { ADMIN_TOTP_SECRET: TOTP_SECRET }, request: adm('adminVerifyOtp', { token: totp(TOTP_SECRET, NOW, -3) }) });
add('adminVerifyOtp: a code with spaces is accepted', {
  env: { ADMIN_TOTP_SECRET: TOTP_SECRET },
  request: adm('adminVerifyOtp', { token: `${totp(TOTP_SECRET, NOW).slice(0, 3)} ${totp(TOTP_SECRET, NOW).slice(3)}` }),
});
add('adminVerifyOtp: a numeric token is accepted', {
  env: { ADMIN_TOTP_SECRET: TOTP_SECRET },
  now: NOW + 7 * 30000,
  request: adm('adminVerifyOtp', { token: Number(totp(TOTP_SECRET, NOW + 7 * 30000)) }),
});
add('adminSetupOtp: a new secret is proposed when none is configured', { request: adm('adminSetupOtp', {}) });
add('adminSetupOtp: the configured secret is shown', { env: { ADMIN_TOTP_SECRET: TOTP_SECRET }, request: adm('adminSetupOtp', {}) });
add('adminSetupOtp: a test code is checked against the candidate secret', {
  steps: [adm('adminSetupOtp', { testToken: totp(TOTP_SECRET, NOW), candidateSecret: TOTP_SECRET }), adm('adminSetupOtp', { testToken: '000000', candidateSecret: TOTP_SECRET })],
});
add('adminSetupOtp: a test code without any secret is refused', { request: adm('adminSetupOtp', { testToken: '123456' }) });
add('adminSetupOtp: a test code falls back to the configured secret', { env: { ADMIN_TOTP_SECRET: TOTP_SECRET }, request: adm('adminSetupOtp', { testToken: totp(TOTP_SECRET, NOW) }) });

// ── adminStats ──────────────────────────────────────────────────────────────
add('adminStats: dashboard aggregates', {
  seed: () => ({
    'users/a': { createdAt: ts(NOW - 60 * 60 * 1000), displayName: 'Alice', username: 'alice' },
    'users/b': { createdAt: ts(NOW - 3 * DAY), first_name: 'Bob' },
    'users/c': { createdAt: ts(NOW - 20 * DAY) },
    'users/d': { createdAt: ts(NOW - 45 * DAY) },
    'users/e': { name: 'no createdAt' },
    'subscriptions/a': { status: 'active', plan: 'pro', endDateMs: NOW + 5 * DAY },
    'subscriptions/b': { status: 'active', plan: 'premium', expiresAt: ts(NOW + 5 * DAY) },
    'subscriptions/c': { status: 'active', plan: 'pro', endDateMs: NOW - DAY },
    'subscriptions/d': { status: 'cancelled', plan: 'pro', endDateMs: NOW + DAY },
    'payments/p1': { status: 'CONFIRMED', amount: 299, createdAt: ts(NOW - DAY), userId: 'a', plan: 'pro', transactionId: 'x1' },
    'payments/p2': { status: 'confirmed', finalAmount: 599, createdAt: ts(NOW - 40 * DAY), userId: 'b', txHash: 'h' },
    'payments/p3': { status: 'PENDING', amount: 999, createdAt: ts(NOW - DAY), userId: 'c' },
    'payments/p4': { status: 'confirmed', amount: 100, createdAt: ts(NOW - 2 * DAY), userId: 'd', method: 'stars', promoCode: 'X' },
    'referrers/R1': { totalEarned: 50, pendingPayout: 20 },
    'referrers/R2': { totalEarned: 500, pendingPayout: 30 },
    'referrers/R3': { totalEarned: 10 },
    'referrers/R4': { totalEarned: 70, pendingPayout: 1 },
    'referrers/R5': { totalEarned: 5 },
    'referrers/R6': { totalEarned: 90 },
    'referrers/R7': { pendingPayout: 2 },
    'aiUsage/a': { month: '2026-10', textRequests: 3, imageRequests: 1, pdfReports: 1 },
    'aiUsage/b': { month: '2026-09', textRequests: 50 },
  }),
  request: adm('adminStats', {}),
});

// ── adminUsers ──────────────────────────────────────────────────────────────
add('adminUsers: debug sample', {
  seed: { 'users/a': { createdAt: ts('2026-10-01T00:00:00Z'), subscription: { plan: 'pro' }, tags: ['x'], n: 1 } },
  request: adm('adminUsers', { action: 'debug' }),
});
add('adminUsers: actions need a userId', { request: adm('adminUsers', { action: 'block' }) });
add('adminUsers: grant a subscription to a new subscriber', { request: adm('adminUsers', { action: 'grant_subscription', userId: 'u1' }) });
add('adminUsers: grant extends a later expiry', {
  seed: { 'subscriptions/u1': { plan: 'pro', status: 'active', expiresAt: ts(NOW + 10 * DAY), endDateMs: NOW + 10 * DAY } },
  request: adm('adminUsers', { action: 'grant_subscription', userId: 'u1', plan: 'premium', periodMonths: '3' }),
});
add('adminUsers: grant uses endDateMs when there is no expiresAt', {
  seed: { 'subscriptions/u1': { plan: 'pro', status: 'active', endDateMs: NOW + 40 * DAY } },
  request: adm('adminUsers', { action: 'grant_subscription', userId: 'u1' }),
});
add('adminUsers: grant ignores a past expiry', {
  seed: { 'subscriptions/u1': { plan: 'pro', status: 'active', expiresAt: ts(NOW - 10 * DAY) } },
  request: adm('adminUsers', { action: 'grant_subscription', userId: 'u1', periodMonths: 12 }),
});
add('adminUsers: send_message needs text', { request: adm('adminUsers', { action: 'send_message', userId: 'u1' }) });
add('adminUsers: send_message to an unknown user is 404', { request: adm('adminUsers', { action: 'send_message', userId: 'u1', text: 'hi' }) });
add('adminUsers: send_message without Telegram link is 400', { seed: { 'users/u1': { email: 'x@example.test' } }, request: adm('adminUsers', { action: 'send_message', userId: 'u1', text: 'hi' }) });
add('adminUsers: send_message is delivered', { seed: { 'users/u1': { chatId: 555 } }, fetch: [TG_OK], request: adm('adminUsers', { action: 'send_message', userId: 'u1', text: '<b>hi</b>' }) });
add('adminUsers: send_message reports a Telegram refusal', {
  seed: { 'users/u1': { telegramId: 556 } },
  fetch: [{ match: /\/sendMessage$/, json: { ok: false, description: 'Forbidden: bot was blocked by the user' } }],
  request: adm('adminUsers', { action: 'send_message', userId: 'u1', text: 'hi' }),
});
add('adminUsers: block and unblock', {
  seed: { 'users/u1': { status: 'active', name: 'x' } },
  steps: [adm('adminUsers', { action: 'block', userId: 'u1' }), adm('adminUsers', { action: 'unblock', userId: 'u1' })],
});
add('adminUsers: unknown action is 400', { request: adm('adminUsers', { action: 'delete_everything', userId: 'u1' }) });
const USERS_LIST = () => ({
  'users/a': { createdAt: ts(NOW - DAY), displayName: 'Alice', email: 'alice@example.test', chatId: 101, username: 'alice' },
  'users/b': { createdAt: ts(NOW - 2 * DAY), chatId: 102 },
  'users/c': { telegramId: 103, firstName: 'Carol', isPro: true, referredByInfluencer: 'BLOG' },
  'users/d': { createdAt: ts(NOW - 3 * DAY), name: 'Dan', subscription: { status: 'active', plan: 'premium', endDate: iso(NOW + 9 * DAY) }, status: 'blocked' },
  'users/e': { createdAt: ts(NOW - 4 * DAY), chatId: 105 },
  'subscriptions/a': { status: 'active', plan: 'pro', endDateMs: NOW + 3 * DAY },
  'subscriptions/b': { status: 'active', trialPlan: 'pro', endDateMs: NOW - DAY },
  'subscriptions/e': { status: 'active', expiresAt: ts(NOW + DAY) },
  'users/f': { createdAt: ts(NOW - 5 * DAY), username: 'fay' },
  'subscriptions/f': { status: 'active', trialPlan: 'premium', endDateMs: NOW + DAY },
});
add('adminUsers: list joins subscriptions and fills missing names from Telegram', {
  seed: USERS_LIST,
  fetch: [
    { match: (u) => /getChat\?chat_id=102$/.test(u), json: { ok: true, result: { first_name: 'Bea', last_name: 'B', username: 'bea' } } },
    { match: (u) => /getChat\?chat_id=105$/.test(u), json: { ok: false, description: 'chat not found' } },
  ],
  request: adm('adminUsers', {}),
});
add('adminUsers: list search and limit', {
  seed: USERS_LIST,
  env: { TELEGRAM_BOT_TOKEN: null },
  steps: [adm('adminUsers', { search: 'ALI' }), adm('adminUsers', { limit: 2 }), adm('adminUsers', { limit: 'abc', search: '10' })],
});
add('adminUsers: list survives a failing subscriptions read', {
  seed: USERS_LIST,
  env: { TELEGRAM_BOT_TOKEN: null },
  failures: [{ collection: 'subscriptions', message: 'subs down' }],
  request: adm('adminUsers', {}),
});

// ── adminSubscriptions ──────────────────────────────────────────────────────
add('adminSubscriptions: update needs a userId', { request: adm('adminSubscriptions', { action: 'update' }) });
add('adminSubscriptions: cancel', {
  seed: { 'subscriptions/u1': { plan: 'pro', status: 'active' }, 'users/u1': { isPro: true } },
  request: adm('adminSubscriptions', { action: 'update', userId: 'u1', status: 'cancelled' }),
});
add('adminSubscriptions: extend from a later expiry and change plan', {
  seed: { 'subscriptions/u1': { plan: 'pro', status: 'active', expiresAt: ts(NOW + 10 * DAY) } },
  request: adm('adminSubscriptions', { action: 'update', userId: 'u1', plan: 'premium', periodMonths: 1 }),
});
add('adminSubscriptions: extend a missing subscription from now', {
  request: adm('adminSubscriptions', { action: 'update', userId: 'u1', periodMonths: 2, status: 'active' }),
});
add('adminSubscriptions: list', {
  seed: {
    'subscriptions/a': { plan: 'pro', period: 'month', status: 'active', endDate: '2026-11-01', endDateMs: 1, paymentMethod: 'sbp', promoCode: 'P', updatedAt: ts('2026-10-01T00:00:00Z') },
    'subscriptions/b': { plan: 'premium', status: 'active', expiresAt: ts('2026-12-01T00:00:00Z'), lastPaymentMethod: 'stars', grantedByAdmin: true },
  },
  steps: [adm('adminSubscriptions', {}), adm('adminSubscriptions', { limit: 1 })],
});

// ── adminPayments ───────────────────────────────────────────────────────────
add('adminPayments: list, filters and revenue', {
  seed: {
    'payments/p1': { userId: 'a', amount: 299, status: 'CONFIRMED', transactionId: 't1', createdAt: ts('2026-10-01T00:00:00Z'), plan: 'pro', period: 'month' },
    'payments/p2': { userId: 'b', finalAmount: 599, status: 'confirmed', txHash: 'h' },
    'payments/p3': { userId: 'c', amount: 10, status: 'pending', network: 'usdt' },
    'payments/p4': { userId: 'd', amount: 50, status: 'confirmed', method: 'stars', promoCode: 'X', referralCode: 'R' },
    'payments/p5': { userId: 'e', status: 'failed' },
  },
  steps: [adm('adminPayments', {}), adm('adminPayments', { statusFilter: 'confirmed' }), adm('adminPayments', { methodFilter: 'ton', limit: 500 })],
});

// ── adminReferrals ──────────────────────────────────────────────────────────
add('adminReferrals: create needs code and name', { request: adm('adminReferrals', { action: 'create', code: 'x' }) });
add('adminReferrals: create', { request: adm('adminReferrals', { action: 'create', code: ' blog ', name: 'Blog', commissionPercent: '20' }) });
add('adminReferrals: update needs a referrerId', { request: adm('adminReferrals', { action: 'update' }) });
add('adminReferrals: update', {
  seed: { 'referrers/BLOG': { code: 'BLOG', status: 'active', commissionPercent: 30 } },
  request: adm('adminReferrals', { action: 'update', referrerId: 'blog', commissionPercent: 0, discountPercent: '5', status: 'paused', paymentDetails: { card: '****' } }),
});
add('adminReferrals: payout needs fields', { request: adm('adminReferrals', { action: 'payout', referrerId: 'x' }) });
add('adminReferrals: payout to an unknown referrer is 404', { request: adm('adminReferrals', { action: 'payout', referrerId: 'x', amount: 1 }) });
add('adminReferrals: payout with nothing pending is 400', { seed: { 'referrers/X': { pendingPayout: 0 } }, request: adm('adminReferrals', { action: 'payout', referrerId: 'x', amount: 1 }) });
add('adminReferrals: payout', { seed: REF, request: adm('adminReferrals', { action: 'payout', referrerId: 'abc123', amount: 120 }) });
add('adminReferrals: a payout covering several earnings', {
  seed: { ...REF, 'referrers/ABC123': { code: 'ABC123', pendingPayout: 400, paidOut: 10 } },
  request: adm('adminReferrals', { action: 'payout', referrerId: 'ABC123', amount: 349.9995 }),
});
add('adminReferrals: list', {
  seed: { ...REF, 'referrers/Z': { code: 'Z' } },
  request: adm('adminReferrals', {}),
});

// ── adminPromoCodes ─────────────────────────────────────────────────────────
add('adminPromoCodes: create needs all fields', { request: adm('adminPromoCodes', { action: 'create', code: 'x', discountPercent: 10 }) });
add('adminPromoCodes: create', { request: adm('adminPromoCodes', { action: 'create', code: ' spring ', discountPercent: '15', maxUses: '100' }) });
add('adminPromoCodes: create with zero discount', { request: adm('adminPromoCodes', { action: 'create', code: 'zero', discountPercent: 0, maxUses: 1 }) });
add('adminPromoCodes: toggle needs a code', { request: adm('adminPromoCodes', { action: 'toggle' }) });
add('adminPromoCodes: toggle', { seed: { 'promoCodes/SPRING': { code: 'SPRING', active: true } }, request: adm('adminPromoCodes', { action: 'toggle', code: 'spring', active: 0 }) });
add('adminPromoCodes: list seeds the built-in codes first', { seed: { 'promoCodes/CUSTOM': { code: 'CUSTOM', active: true, usedCount: 2 } }, request: adm('adminPromoCodes', {}) });

// ── adminMessages ───────────────────────────────────────────────────────────
const AUDIENCE = () => ({
  'users/a': { chatId: 101 },
  'users/a2': { telegramId: 101 },
  'users/b': { chatId: 102 },
  'users/c': { telegramId: 103 },
  'users/d': { email: 'no-telegram@example.test' },
  'subscriptions/a': { status: 'active', plan: 'pro', endDateMs: NOW + DAY },
  'subscriptions/b': { status: 'active', plan: 'premium', expiresAt: ts(NOW + DAY) },
  'subscriptions/c': { status: 'active', plan: 'pro', endDateMs: NOW - DAY },
});
const TG_MIXED = [
  { match: (u, b) => /sendMessage$/.test(u) && b && b.chat_id === '102', json: { ok: false, description: 'blocked' } },
  { match: (u, b) => /sendMessage$/.test(u) && b && b.chat_id === '103', throw: 'socket hang up' },
  TG_OK,
];
add('adminMessages: history', {
  seed: { 'adminMessages/m1': { text: 'hello', sentAt: ts('2026-10-01T00:00:00Z'), total: 3 }, 'adminMessages/m2': { text: 'no date' } },
  request: adm('adminMessages', { action: 'history' }),
});
add('adminMessages: text is required', { request: adm('adminMessages', {}) });
add('adminMessages: a missing bot token is 500', { env: { TELEGRAM_BOT_TOKEN: null }, request: adm('adminMessages', { text: 'x' }) });
add('adminMessages: broadcast to everyone, de-duplicated', { seed: AUDIENCE, fetch: TG_MIXED, request: adm('adminMessages', { text: 'News' }) });
add('adminMessages: broadcast to pro', { seed: AUDIENCE, fetch: TG_MIXED, request: adm('adminMessages', { text: 'Pro news', target: 'pro' }) });
add('adminMessages: broadcast to premium', { seed: AUDIENCE, fetch: TG_MIXED, request: adm('adminMessages', { text: 'Premium news', target: 'premium' }) });
add('adminMessages: broadcast to free', { seed: AUDIENCE, fetch: TG_MIXED, request: adm('adminMessages', { text: 'Free news', target: 'free' }) });
add('adminMessages: send to chosen users', { seed: AUDIENCE, fetch: TG_MIXED, request: adm('adminMessages', { text: 'Hi', target: ['a', 'd', 'missing', 'c'] }) });

// ── adminAiUsage ────────────────────────────────────────────────────────────
add('adminAiUsage: current month by default, explicit month on request', {
  seed: {
    'aiUsage/a': { month: '2026-10', textRequests: 3, imageRequests: 1, pdfReports: 2, updatedAt: ts('2026-10-10T00:00:00Z') },
    'aiUsage/b': { month: '2026-10', textRequests: 7 },
    'aiUsage/c': { month: '2026-09', textRequests: 9 },
  },
  steps: [adm('adminAiUsage', {}), adm('adminAiUsage', { month: '2026-09', limit: 1 })],
});

// ── Stars diagnostics ───────────────────────────────────────────────────────
add('adminStarsDiagnostics: nothing yet', { request: adm('adminStarsDiagnostics', {}) });
add('adminStarsDiagnostics: latest payment, session and subscription', {
  env: { STARS_MINIAPP_ENABLED: 'true', STARS_CANARY_TELEGRAM_IDS: '111, 222' },
  seed: {
    'payments/sp1': { method: 'stars', status: 'confirmed', amount: 250, currency: 'XTR', plan: 'pro', period: 'month', userId: 'u1', paymentSessionId: 's1', telegram_payment_charge_id: 'stxABCDEFGHIJKLMNOP', createdAt: ts('2026-10-14T00:00:00Z') },
    'stars_payment_sessions/s1': { status: 'paid', plan: 'pro', period: 'month', starsAmount: 250, expiresAtMs: NOW - 1000, telegramUserId: 111 },
    'subscriptions/u1': { status: 'active', plan: 'pro', endDate: '2026-11-14', endDateMs: NOW + 30 * DAY, lastPaymentMethod: 'stars' },
  },
  request: adm('adminStarsDiagnostics', {}),
});
add('adminStarsDiagnostics: short charge ids are fully masked', {
  seed: { 'payments/sp1': { method: 'stars', status: 'pending', telegram_payment_charge_id: 'short', is_recurring: true } },
  request: adm('adminStarsDiagnostics', {}),
});
add('adminStarsCanaryCheck: initData is required', { request: adm('adminStarsCanaryCheck', {}) });
add('adminStarsCanaryCheck: a forged initData resolves no user', {
  env: { STARS_CANARY_TELEGRAM_IDS: '111' },
  request: adm('adminStarsCanaryCheck', { initData: 'user=%7B%22id%22%3A111%7D&hash=00' }),
});
add('adminStarsCanaryCheck: a canary user', {
  env: { STARS_CANARY_TELEGRAM_IDS: '111,abc', STARS_MINIAPP_ENABLED: 'false' },
  request: adm('adminStarsCanaryCheck', { initData: miniAppInitData({ id: 111, first_name: 'C' }, Math.floor(NOW / 1000) - 30) }),
});
add('adminStarsCanaryCheck: a user outside the canary with Stars on for everyone', {
  env: { STARS_CANARY_TELEGRAM_IDS: '', STARS_MINIAPP_ENABLED: 'true' },
  request: adm('adminStarsCanaryCheck', { initData: miniAppInitData({ id: 999, first_name: 'X' }, Math.floor(NOW / 1000) - 30) }),
});

// ── habit smoke test ────────────────────────────────────────────────────────
add('adminHabitSmokeTestCreate: default offset in the user zone', {
  seed: { [`users/${SMOKE_UID}`]: { timezone: 'Asia/Almaty' } },
  request: adm('adminHabitSmokeTestCreate', {}),
});
add('adminHabitSmokeTestCreate: the offset is clamped to 15..30 minutes', {
  steps: [adm('adminHabitSmokeTestCreate', { minutesFromNow: 5 }), adm('adminHabitSmokeTestCreate', { minutesFromNow: '45' }), adm('adminHabitSmokeTestCreate', { minutesFromNow: 'soon' })],
});
add('adminHabitSmokeTestStatus: habit and its reminders', {
  seed: {
    'habits/enma-smoke-test-habit': { archived: false, reminderTime: '10:00', userId: SMOKE_UID },
    'reminders/habit-enma-smoke-test-habit-2026-10-15': { habitId: 'enma-smoke-test-habit', status: 'sent', scheduledAt: ts('2026-10-15T07:00:00Z'), sentAt: ts('2026-10-15T07:01:00Z'), source: 'habit', retryCount: 0 },
    'reminders/habit-enma-smoke-test-habit-2026-10-16': { habitId: 'enma-smoke-test-habit', status: 'pending', scheduledAt: ts('2026-10-16T07:00:00Z'), lastError: 'x' },
    'reminders/other': { habitId: 'other', status: 'pending' },
  },
  request: adm('adminHabitSmokeTestStatus', {}),
});
add('adminHabitSmokeTestStatus: nothing exists', { request: adm('adminHabitSmokeTestStatus', {}) });
add('adminHabitSmokeTestDelete: confirmation is required', { request: adm('adminHabitSmokeTestDelete', { confirm: 'yes' }) });
add('adminHabitSmokeTestDelete: removes the habit and only its reminders', {
  seed: {
    'habits/enma-smoke-test-habit': { archived: false },
    'reminders/r1': { habitId: 'enma-smoke-test-habit' },
    'reminders/r2': { habitId: 'enma-smoke-test-habit' },
    'reminders/keep': { habitId: 'other' },
  },
  request: adm('adminHabitSmokeTestDelete', { confirm: 'DELETE_SMOKE_TEST_HABIT' }),
});

// ── notes diagnostic ────────────────────────────────────────────────────────
add('adminNotesDiagnostic: uid is required', { request: adm('adminNotesDiagnostic', { uid: 5 }) });
add('adminNotesDiagnostic: compareUid must be a string', { request: adm('adminNotesDiagnostic', { uid: 'u1', compareUid: 7 }) });
add('adminNotesDiagnostic: structural report without note contents', {
  seed: {
    'notes/n1': { userId: 'u1', title: 'PRIVATE-TITLE', content: 'PRIVATE-CONTENT', updatedAt: ts('2026-10-01T00:00:00Z'), rev: 3, type: 'text', category: 'work' },
    'notes/n2': { userId: 'u1', title: 'x', type: 'checklist', archived: true },
    'notes/n3': { userId: 'u1', content: 5, isDeleted: true, updatedAt: '2026-10-01' },
    'notes/n4': { userId: 'u2', title: 'other', content: '', updatedAt: ts('2026-10-01T00:00:00Z'), rev: 1 },
    'users/u1/notes/legacy1': { title: 'old' },
    'users/u1/notes/legacy2': { title: 'old', userId: 'u1' },
    'users/u1/freeUsage/counters': { noteCount: 5 },
    'telegramUsers/tg_1': { firebaseUid: 'u1' },
  },
  request: adm('adminNotesDiagnostic', { uid: 'u1', compareUid: 'u2' }),
});
add('adminNotesDiagnostic: comparing an account with itself', { request: adm('adminNotesDiagnostic', { uid: 'u1', compareUid: 'u1' }) });

module.exports = { scenarios };
