'use strict';

const a = require('../assertions');
const { createMockDb, mockAdmin, mockGetUserTimezone } = require('../fixtures');

// ── Helper: inject firebaseAdmin mock ─────────────────────────────────────────

function injectMockDb(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: { db: mockDb, admin: mockAdmin, getUserTimezone: mockGetUserTimezone },
  };
  // Clear aiTools so it re-requires the new db
  const at = require.resolve('../../aiTools');
  delete require.cache[at];
}

function teardownMockDb() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  delete require.cache[require.resolve('../../aiTools')];
}

// ── Task creation scenarios ────────────────────────────────────────────────────

const taskScenarios = [
  {
    id:          'tasks.create.basic',
    description: 'SPEC §14: create_task called once, verifiedUid used, entity written to DB',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'create_task', { title: 'Купить билеты' });

        a.toolSuccess(result, 'create_task');
        a.ok(result.data?.id, 'task id returned');
        a.ok(result.data?.title === 'Купить билеты', 'title preserved');
        // Verify entity was actually written to DB
        const taskId = result.data.id;
        a.dbEntryExists(db, `tasks/${taskId}`, 'task in DB');
        const written = db._get(`tasks/${taskId}`);
        a.eq(written.userId, 'user_a', 'userId written with verifiedUid');

        this.snapshot = { id: taskId, title: written.title, userId: written.userId };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tasks.create.validation',
    description: 'SPEC §62: create_task with empty title → VALIDATION_ERROR, 0 writes',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'create_task', { title: '' });

        a.toolFailure(result, 'VALIDATION_ERROR', 'empty title');
        a.dbCountEquals(db, 'tasks/', 0, 'no tasks written');

        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tasks.create.negative_amount_invalid',
    description: 'SPEC §62: create_transaction with amount=-500 → VALIDATION_ERROR, 0 writes',
    domain:      'tasks',
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
          type: 'expense', amount: -500, description: 'Test',
        });

        a.toolFailure(result, 'VALIDATION_ERROR', 'negative amount');
        a.dbCountEquals(db, 'transactions/', 0, 'no transactions written');

        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tasks.unknown_tool',
    description: 'SPEC §61: unknown tool name → UNKNOWN_TOOL error, not executed',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({});
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'finance.super_magic', {});

        a.toolFailure(result, 'UNKNOWN_TOOL', 'unknown tool');
        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'tasks.free_plan_limit',
    description: 'SPEC §54: free plan at daily limit → LIMIT_REACHED, no entity created',
    domain:      'tasks',
    critical:    false,
    snapshot:    {},
    async run() {
      const today = new Date().toISOString().slice(0, 10);
      const db = createMockDb({
        'subscriptions/user_free': { status: 'active', plan: 'free' },
        // Simulate daily counter at limit (5 tasks/day for free plan)
        'users/user_free/freeUsage/counters': {
          dailyTaskCount: 5,
          date:           today,
        },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_free', 'create_task', { title: 'Task over limit' });

        a.toolFailure(result, 'LIMIT_REACHED', 'free plan limit');
        a.dbCountEquals(db, 'tasks/', 0, 'no task created at limit');

        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },
];

// ── Conversation state for tasks ───────────────────────────────────────────────

const stateScenarios = [
  {
    id:          'tasks.pending.validation',
    description: 'SPEC §15: create_reminder with missing time → MISSING_FIELDS, pendingAction',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    run() {
      const { validateToolArgs } = require('../../conversationState');
      const result = validateToolArgs('create_reminder', {
        title: 'Оплатить интернет',
        date:  'tomorrow',
        // time is missing
      });

      a.ok(!result.valid, 'validation should fail');
      a.ok(result.missingFields?.includes('time'), 'time should be in missingFields');
      a.eq(result.errorCode, 'MISSING_REQUIRED_FIELDS', 'error code');

      this.snapshot = {
        valid:         result.valid,
        missingFields: result.missingFields,
        collectedArgs: result.collectedArgs,
      };
    },
  },

  {
    id:          'tasks.pending.followup_detected',
    description: 'SPEC §15: follow-up "В 18:00" with active pendingAction state recognized',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectFollowUp } = require('../../conversationState');
      const state = {
        status:       'awaiting_clarification',
        activeSkills: ['tasks'],
        pendingAction: {
          toolName:      'create_reminder',
          collectedArgs: { title: 'Оплатить интернет', date: '2026-09-18' },
          missingFields: ['time'],
          expiresAt:     Date.now() + 30 * 60 * 1000,
        },
      };
      const isFollowUp = detectFollowUp('В 18:00.', state);
      a.ok(isFollowUp, 'short answer with active pending should be a follow-up');
      this.snapshot = { isFollowUp };
    },
  },

  {
    id:          'tasks.cancel.pending_cleared',
    description: 'SPEC §25: "Не надо" with pendingAction → cancel detected, state should be cleared',
    domain:      'tasks',
    critical:    true,
    snapshot:    {},
    run() {
      const { detectCancelIntent } = require('../../conversationState');
      for (const msg of ['не надо', 'Отмени', 'Забудь об этом', 'стоп', 'не хочу']) {
        a.ok(detectCancelIntent(msg), `"${msg}" should be recognized as cancel`);
      }
      a.ok(!detectCancelIntent('Напомни завтра'), 'normal message is not cancel');
      this.snapshot = { tested: 5 };
    },
  },
];

// ── Routing for tasks ─────────────────────────────────────────────────────────

const routingScenarios = [
  {
    id:          'tasks.routing.basic',
    description: 'Task creation message → tasks domain selected',
    domain:      'tasks',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeByRules } = require('../../contextRouter');
      const r = routeByRules('Создай задачу купить билеты завтра.', []);
      a.domainSelected(r, 'tasks');
      this.snapshot = { domains: r.domains };
    },
  },

  {
    id:          'tasks.routing.reminder',
    description: '"Напомни" → reminders domain',
    domain:      'tasks',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeByRules } = require('../../contextRouter');
      const r = routeByRules('Напомни завтра оплатить интернет.', []);
      a.domainSelected(r, 'reminders');
      this.snapshot = { domains: r.domains };
    },
  },
];

module.exports = [...taskScenarios, ...stateScenarios, ...routingScenarios];
