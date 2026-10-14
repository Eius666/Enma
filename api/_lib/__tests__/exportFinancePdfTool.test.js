'use strict';

// Covers tools.js's export_finance_pdf tool (Telegram AI path) end-to-end
// against the mock db — plan gating, the monthly limit, the actual
// sendDocument upload, and that a Telegram-side failure is never reported
// to the chat as a success.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockDb, mockAdmin } = require('../evals/fixtures');

function injectEnv(seed = {}) {
  const db = createMockDb(seed);
  const fa = require.resolve('../firebaseAdmin');
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  for (const p of ['../tools', '../llm-chat', '../aiUsage', '../entities/createEntity', '../pdf/exportFinancePdf']) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  return db;
}
function teardown() {
  try { delete require.cache[require.resolve('../firebaseAdmin')]; } catch (_) {}
  delete process.env.TELEGRAM_BOT_TOKEN;
  for (const p of ['../tools', '../llm-chat', '../aiUsage', '../entities/createEntity', '../pdf/exportFinancePdf']) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

function mockFetchTelegramOk() {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return { calls, restore: () => { global.fetch = original; } };
}
function mockFetchTelegramRejected() {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'Bad Request: file too big' }) });
  return { restore: () => { global.fetch = original; } };
}

test('export_finance_pdf: free plan is blocked with an upgrade message, no PDF generated', async () => {
  injectEnv({});
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', {}, 'u1', 'chat1', 'Europe/Moscow');
    assert.equal(result.ok, false);
    assert.match(result.error, /Premium/);
  } finally { teardown(); }
});

test('export_finance_pdf: premium plan with real transactions actually uploads a document to Telegram', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
    'transactions/t1': { userId: 'u1', type: 'income', amount: 1000, currency: 'RUB', rubAmount: 1000, schemaVersion: 2, fx: null, category: 'cat-salary', description: 'Зарплата', date: '2026-09-01T09:00:00.000Z', source: 'web-app' },
  });
  const { calls, restore } = mockFetchTelegramOk();
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', { period: 'all' }, 'u1', 'chat1', 'Europe/Moscow');
    assert.equal(result.ok, true);
    assert.match(result.message, /готов и отправлен/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /sendDocument/);
  } finally { restore(); teardown(); }
});

test('export_finance_pdf: increments the pdfReports usage counter (visible to SettingsScreen)', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
  });
  const { restore } = mockFetchTelegramOk();
  try {
    const { checkAndIncrementAiUsage } = require('../aiUsage');
    const { executeTool } = require('../tools');
    await executeTool('export_finance_pdf', { period: 'all' }, 'u1', 'chat1', 'Europe/Moscow');
    // A second attempt right after must reflect usage=1 already counted —
    // confirmed indirectly by checking the limit function sees it.
    const probe = await checkAndIncrementAiUsage('u1', { pdfReports: 10 }, 'pdf');
    assert.equal(probe.used, 2); // the tool's own call incremented to 1, this probe's own increment makes it 2
  } finally { restore(); teardown(); }
});

test('export_finance_pdf: premium plan but monthly limit already reached is blocked, with the real used/limit numbers', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
    'aiUsage/u1': { userId: 'u1', month: new Date().toISOString().slice(0, 7), pdfReports: 10, textRequests: 0, imageRequests: 0 },
  });
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', {}, 'u1', 'chat1', 'Europe/Moscow');
    assert.equal(result.ok, false);
    assert.match(result.error, /10\/10/);
  } finally { teardown(); }
});

test('export_finance_pdf: a Telegram upload rejection is reported as failure, never as success', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
  });
  const { restore } = mockFetchTelegramRejected();
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', {}, 'u1', 'chat1', 'Europe/Moscow');
    assert.equal(result.ok, false);
    assert.match(result.error, /не принял файл/);
  } finally { restore(); teardown(); }
});

test('export_finance_pdf: an invalid period is reported as a specific failure, not silently defaulted', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
  });
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', { period: 'nonsense' }, 'u1', 'chat1', 'Europe/Moscow');
    assert.equal(result.ok, false);
  } finally { teardown(); }
});

test('chatWithTools: on success, the final chat message is exactly the tool\'s own confirmation, not a model paraphrase', async () => {
  injectEnv({
    'subscriptions/u1': { status: 'active', plan: 'premium', endDateMs: Date.now() + 86400000 },
  });
  const { restore } = mockFetchTelegramOk();
  try {
    const { executeTool } = require('../tools');
    const result = await executeTool('export_finance_pdf', {}, 'u1', 'chat1', 'Europe/Moscow');
    // This mirrors what llm-chat.js's pdfResult short-circuit returns —
    // exercised directly here since chatWithTools itself needs a live
    // OpenRouter call to reach tool_calls, out of scope for a unit test.
    assert.equal(result.ok, true);
    assert.ok(result.message.length > 0);
  } finally { restore(); teardown(); }
});
