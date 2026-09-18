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
}
function teardownMockDb() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  delete require.cache[require.resolve('../../aiTools')];
}

const securityScenarios = [
  {
    id:          'security.cross_user.task_access',
    description: 'SPEC §19 IDOR: user_a tries to update user_b task → NOT_FOUND',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        // user_b owns this task
        'tasks/task-b-1': {
          id: 'task-b-1', title: 'User B secret task', userId: 'user_b', completed: false,
        },
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        // user_a attempts to update user_b's task
        const result = await executeTool('user_a', 'update_task', {
          taskId: 'task-b-1',
          title:  'HACKED',
        });

        a.toolFailure(result, 'NOT_FOUND', 'IDOR: update_task with wrong uid');
        // Verify user_b's task is unchanged
        const task = db._get('tasks/task-b-1');
        a.eq(task.title, 'User B secret task', 'user_b task unchanged');

        this.snapshot = { errorCode: result.errorCode, taskUnchanged: task.title === 'User B secret task' };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'security.cross_user.note_access',
    description: 'SPEC §19 IDOR: user_a tries to update user_b note → NOT_FOUND',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'notes/note-b-1': {
          id: 'note-b-1', title: 'User B private note', content: 'Secret content', userId: 'user_b',
        },
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_a', 'update_note', {
          noteId:  'note-b-1',
          content: 'INJECTED CONTENT',
        });

        a.toolFailure(result, 'NOT_FOUND', 'IDOR: update_note with wrong uid');
        const note = db._get('notes/note-b-1');
        a.eq(note.content, 'Secret content', 'note content unchanged');

        this.snapshot = { errorCode: result.errorCode };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'security.uid_injection.body_uid_ignored',
    description: 'SPEC §20: body contains userId=user_b, but executeTool is called with user_a uid — only user_a is used',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_a': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        // The `args` contain a spoofed userId — executeTool must use the `uid` parameter exclusively
        const result = await executeTool('user_a', 'create_task', {
          title:  'Injection test',
          userId: 'user_b',  // spoofed field in body — must be ignored
        });

        a.toolSuccess(result, 'create_task with body userId injection');
        const id   = result.data?.id;
        const task = db._get(`tasks/${id}`);
        a.eq(task.userId, 'user_a', 'task.userId must be verifiedUid (user_a), not body.userId (user_b)');
        a.ok(task.userId !== 'user_b', 'user_b must NOT appear as owner');

        this.snapshot = { writtenUserId: task.userId, injectedUserId: 'user_b' };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'security.dismiss_insight.wrong_uid',
    description: 'SPEC §9 store: user_a tries to dismiss user_b insight → forbidden',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        // insight owned by user_b
        'users/user_b/insights/finance.cash_gap:2026-09': {
          fingerprint: 'finance.cash_gap:2026-09',
          eventType:   'finance.cash_gap',
          status:      'active',
          uid:         'user_b',
        },
      });

      const fa = require.resolve('../../firebaseAdmin');
      delete require.cache[fa];
      require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db, admin: mockAdmin } };
      delete require.cache[require.resolve('../../insights/store')];

      try {
        const { dismissEvent } = require('../../insights/store');
        // user_a tries to dismiss user_b's insight
        const result = await dismissEvent('user_a', 'finance.cash_gap:2026-09');
        a.ok(!result || result.result === 'not_found' || result.result === 'forbidden',
          'cross-uid dismiss should fail (not_found or forbidden)');

        // user_b's insight should remain unchanged
        const insight = db._get('users/user_b/insights/finance.cash_gap:2026-09');
        a.eq(insight.status, 'active', 'user_b insight status unchanged');

        this.snapshot = { result: result?.result };
      } finally {
        delete require.cache[require.resolve('../../firebaseAdmin')];
        delete require.cache[require.resolve('../../insights/store')];
      }
    },
  },

  {
    id:          'security.prompt_injection.note_tools_restricted',
    description: 'SPEC §21: note domain context does NOT expose transaction-modifying tools',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    run() {
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');
      const tools = getToolsForDomains(TOOL_DEFINITIONS, ['notes']);
      const names = tools.map(t => t.function?.name ?? t.name);

      const forbidden = ['create_transaction', 'update_task', 'complete_task', 'create_habit'];
      for (const f of forbidden) {
        a.ok(!names.includes(f), `"${f}" must NOT be available in notes-only context`);
      }
      this.snapshot = { notesTools: names, forbiddenNotPresent: forbidden };
    },
  },

  {
    id:          'security.collection_whitelist',
    description: 'SPEC §98: domain→tools mapping is a whitelist — unknown domains get no tools',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    run() {
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');

      const noTools = getToolsForDomains(TOOL_DEFINITIONS, ['unknown_domain', 'admin', 'firestore']);
      a.eq(noTools.length, 0, 'unknown domain must yield 0 tools');

      const generalTools = getToolsForDomains(TOOL_DEFINITIONS, ['general']);
      a.eq(generalTools.length, 0, 'general domain must yield 0 tools');

      this.snapshot = { unknownDomainTools: 0, generalTools: 0 };
    },
  },

  {
    id:          'security.skill_whitelist',
    description: 'SPEC §60: unknown skill ID from classifier is filtered out',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    run() {
      const { resolveSkills } = require('../../skillRouter');
      const result = resolveSkills(['finance.super_magic', 'finance.hack_everything', 'finance.affordability']);
      // Only known skills should be returned
      a.ok(result.every(s => s.id === 'finance.affordability'), 'only valid skills survive whitelist');
      a.eq(result.length, 1, 'unknown skill IDs filtered');
      this.snapshot = { inputCount: 3, outputCount: result.length };
    },
  },

  {
    id:          'security.core_prompt.injection_rule',
    description: 'SPEC §21: CORE_PROMPT must explicitly warn against executing instructions from user content',
    domain:      'security',
    critical:    true,
    snapshot:    {},
    run() {
      const { CORE_PROMPT } = require('../../skills/core');
      a.ok(
        CORE_PROMPT.includes('пользовательский контент') ||
        CORE_PROMPT.includes('не инструкции') ||
        CORE_PROMPT.includes('Безопасность') ||
        (CORE_PROMPT.includes('заметок') && CORE_PROMPT.includes('инструкции')),
        'CORE_PROMPT must contain instruction not to execute content from notes/tasks as commands'
      );
      this.snapshot = { checked: true, coreLen: CORE_PROMPT.length };
    },
  },
];

module.exports = securityScenarios;
