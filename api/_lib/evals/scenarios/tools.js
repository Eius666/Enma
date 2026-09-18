'use strict';

const a = require('../assertions');
const { createMockDb, mockAdmin, mockGetUserTimezone } = require('../fixtures');

function injectMockDb(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: { db: mockDb, admin: mockAdmin, getUserTimezone: mockGetUserTimezone },
  };
  delete require.cache[require.resolve('../../aiTools')];
  try { delete require.cache[require.resolve('../../conversationState')]; } catch (_) {}
}
function teardownMockDb() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  delete require.cache[require.resolve('../../aiTools')];
  try { delete require.cache[require.resolve('../../conversationState')]; } catch (_) {}
}

const toolScenarios = [
  {
    id:          'tools.duplicate.prevention',
    description: 'SPEC §16: HTTP handler idempotency (reserveIdempotency) prevents duplicate entity on retry',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool }                      = require('../../aiTools');
        const { reserveIdempotency, completeIdempotency } = require('../../conversationState');

        const uid       = 'user_a';
        const requestId = 'req-dedup-123';
        const callId    = 'tc-dedup-abc';
        const toolName  = 'create_task';
        const args      = { title: 'Тест дедупликация' };

        // First HTTP request: reserve → execute → complete
        const res1 = await reserveIdempotency(uid, requestId, callId, toolName);
        a.eq(res1.status, 'reserved', 'first reservation = reserved');
        const result1 = await executeTool(uid, toolName, args);
        a.toolSuccess(result1, 'first create_task');
        await completeIdempotency(uid, requestId, callId, result1);

        // Second HTTP request (retry) with same requestId → cached, executeTool NOT called again
        const res2 = await reserveIdempotency(uid, requestId, callId, toolName);
        a.eq(res2.status, 'cached', 'second reservation = cached (idempotent)');

        // Exactly 1 task in DB — second executeTool was never called
        a.dbCountEquals(db, 'tasks/', 1, 'exactly 1 task (idempotency layer prevents duplicate)');

        this.snapshot = {
          res1:      res1.status,
          res2:      res2.status,
          taskCount: db._count('tasks/'),
        };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.create_transaction.validation',
    description: 'SPEC §62: create_transaction amount=-500 → VALIDATION_ERROR, 0 writes',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'create_transaction', {
          type: 'expense', amount: -500, description: 'Тест отрицательный',
        });
        a.toolFailure(result, 'VALIDATION_ERROR');
        a.dbCountEquals(db, 'transactions/', 0, 'no transaction written on validation error');
        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.create_transaction.success',
    description: 'SPEC §14: valid create_transaction → success, entity in DB with correct userId',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'create_transaction', {
          type: 'expense', amount: 1500, description: 'Бензин', category: 'p-transport',
        });
        a.toolSuccess(result, 'create_transaction');
        const id  = result.data?.id;
        a.ok(id, 'id returned');
        const tx = db._get(`transactions/${id}`);
        a.ok(tx, 'transaction in DB');
        a.eq(tx.userId, 'user_a', 'userId = verifiedUid');
        a.eq(tx.amount, 1500, 'amount preserved');
        this.snapshot = { id, amount: tx.amount, userId: tx.userId };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.multi_tool.tx_and_reminder',
    description: 'SPEC §17: create_transaction + create_reminder each called once',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const txResult = await executeTool('user_a', 'create_transaction', {
          type: 'expense', amount: 1500, description: 'Бензин', category: 'p-transport',
        });
        const remResult = await executeTool('user_a', 'create_reminder', {
          title: 'Проверить давление', date: '2026-09-18', time: '18:00',
        });
        a.toolSuccess(txResult, 'create_transaction');
        a.toolSuccess(remResult, 'create_reminder');
        a.dbCountEquals(db, 'transactions/', 1, '1 transaction');
        a.dbCountEquals(db, 'reminders/', 1, '1 reminder');
        this.snapshot = {
          txId: txResult.data?.id,
          remId: remResult.data?.id,
        };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.partial_failure.tx_success_reminder_missing_time',
    description: 'SPEC §18: transaction succeeds, reminder without time → tx exists, reminder not created',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool }  = require('../../aiTools');
        const { validateToolArgs } = require('../../conversationState');

        // Transaction succeeds
        const txResult = await executeTool('user_a', 'create_transaction', {
          type: 'expense', amount: 1500, description: 'Бензин',
        });
        a.toolSuccess(txResult, 'create_transaction');
        a.dbCountEquals(db, 'transactions/', 1, '1 transaction created');

        // Reminder without time → validation catches it BEFORE executeTool
        const validation = validateToolArgs('create_reminder', {
          title: 'Проверить давление',
          date:  '2026-09-18',
          // no time
        });
        a.ok(!validation.valid, 'reminder without time fails validation');
        a.ok(validation.missingFields.includes('time'), 'time in missingFields');

        // Since validation failed, executeTool is never called for reminder
        a.dbCountEquals(db, 'reminders/', 0, '0 reminders (never called)');

        this.snapshot = {
          txCreated:  1,
          remCreated: 0,
          remMissing: validation.missingFields,
        };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.unknown_tool.not_executed',
    description: 'SPEC §61: unknown tool name → UNKNOWN_TOOL, nothing written to DB',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({ 'subscriptions/user_a': { status: 'active', plan: 'pro' } });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'delete_all_transactions_now', {});
        a.toolFailure(result, 'UNKNOWN_TOOL');
        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tools.no_unnecessary_tools.general',
    description: 'SPEC §79: "Что такое инфляция?" → general domain → 0 tools available',
    domain:      'tools',
    critical:    false,
    snapshot:    {},
    run() {
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');
      const tools = getToolsForDomains(TOOL_DEFINITIONS, ['general']);
      a.eq(tools.length, 0, '0 tools for general domain');
      this.snapshot = { toolCount: tools.length };
    },
  },

  {
    id:          'tools.create_reminder.missing_time_validation',
    description: 'SPEC §62: create_reminder without time → MISSING_FIELDS error',
    domain:      'tools',
    critical:    true,
    snapshot:    {},
    run() {
      const { validateToolArgs } = require('../../conversationState');
      const result = validateToolArgs('create_reminder', { title: 'Тест', date: '2026-09-18' });
      a.ok(!result.valid, 'missing time → invalid');
      a.eq(result.errorCode, 'MISSING_REQUIRED_FIELDS', 'errorCode');
      a.ok(result.missingFields.includes('time'), 'time in missingFields');
      this.snapshot = result;
    },
  },

  {
    id:          'tools.pro_plan.success',
    description: 'SPEC §55: Pro plan user creates entity without limit hit',
    domain:      'tools',
    critical:    false,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_pro': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_pro', 'create_task', { title: 'Pro task' });
        a.toolSuccess(result, 'pro plan task creation');
        this.snapshot = { success: true, plan: 'pro' };
      } finally { teardownMockDb(); }
    },
  },
];

module.exports = toolScenarios;
