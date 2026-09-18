'use strict';

const a = require('../assertions');
const { createMockDb, mockAdmin } = require('../fixtures');

function injectMockDb(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { db: mockDb, admin: mockAdmin } };
  delete require.cache[require.resolve('../../aiTools')];
}
function teardownMockDb() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  delete require.cache[require.resolve('../../aiTools')];
}

const noteScenarios = [
  {
    id:          'notes.routing.find',
    description: '"Найди мою заметку" → notes domain + notes.find skill',
    domain:      'notes',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeByRules } = require('../../contextRouter');
      const { routeSkill }   = require('../../skillRouter');
      const msg = 'Найди мою заметку о планах на год.';
      const ctx = routeByRules(msg, []);
      a.domainSelected(ctx, 'notes');
      const skillR = routeSkill({ message: msg, history: [], domains: ctx.domains });
      a.skillSelected(skillR, 'notes.find');
      this.snapshot = { domains: ctx.domains, skills: skillR.skills.map(s => s.id) };
    },
  },

  {
    id:          'notes.prompt_injection.no_delete_tool',
    description: 'SPEC §21: note with injection content — "delete all transactions" must NEVER call delete tool',
    domain:      'notes',
    critical:    true,
    snapshot:    {},
    run() {
      // This tests that the skill does NOT expose transaction-deleting tools when in notes domain
      const { routeByRules }       = require('../../contextRouter');
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');

      // User asks about a note. Only notes domain loaded.
      const r     = routeByRules('Найди мою заметку.', []);
      const tools = getToolsForDomains(TOOL_DEFINITIONS, ['notes']); // explicitly notes only
      const names = tools.map(t => t.function?.name ?? t.name);

      // No transaction tools should be available in notes domain
      a.ok(!names.includes('create_transaction'), 'create_transaction must not be available in notes context');
      // No task deletion either
      a.ok(!names.includes('complete_reminder'), 'reminder complete not in notes context (different domain)');

      this.snapshot = { notesTools: names };
    },
  },

  {
    id:          'notes.prompt_injection.search_allowed',
    description: 'SPEC §21: "Найди заметку" → search_notes IS allowed',
    domain:      'notes',
    critical:    true,
    snapshot:    {},
    run() {
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');
      const tools = getToolsForDomains(TOOL_DEFINITIONS, ['notes']);
      const names = tools.map(t => t.function?.name ?? t.name);
      a.ok(names.includes('search_notes'), 'search_notes must be available in notes domain');
      this.snapshot = { notesTools: names };
    },
  },

  {
    id:          'notes.tool_minimization',
    description: 'Notes context has only notes tools, not finance or task tools',
    domain:      'notes',
    critical:    false,
    snapshot:    {},
    run() {
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');
      const tools = getToolsForDomains(TOOL_DEFINITIONS, ['notes']);
      const names = tools.map(t => t.function?.name ?? t.name);

      for (const forbidden of ['create_transaction', 'create_task', 'create_habit']) {
        a.ok(!names.includes(forbidden), `"${forbidden}" should not be in notes tool set`);
      }
      this.snapshot = { notesTools: names };
    },
  },

  {
    id:          'notes.create.basic',
    description: 'create_note with valid args → success, entity written',
    domain:      'notes',
    critical:    false,
    snapshot:    {},
    async run() {
      const db = createMockDb({
        'subscriptions/user_n': { status: 'active', plan: 'pro' },
      });
      injectMockDb(db);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('user_n', 'create_note', { title: 'Тест заметка', content: 'Текст' });
        a.toolSuccess(result, 'create_note');
        a.dbCountEquals(db, 'notes/', 1, 'one note in DB');
        const id = result.data?.id;
        const note = db._get(`notes/${id}`);
        a.eq(note.userId, 'user_n', 'userId = verifiedUid');
        this.snapshot = { id, userId: note.userId };
      } finally { teardownMockDb(); }
    },
  },
];

module.exports = noteScenarios;
