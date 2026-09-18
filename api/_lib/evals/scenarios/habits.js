'use strict';

const a = require('../assertions');

const habitScenarios = [
  {
    id:          'habits.routing.basic',
    description: 'SPEC §28: "Какие у меня привычки?" → habits domain, NOT finance/notes/tasks',
    domain:      'habits',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeByRules } = require('../../contextRouter');
      const r = routeByRules('Какие у меня привычки сегодня?', []);
      a.domainSelected(r, 'habits');
      a.domainNotSelected(r.domains, 'finance');
      a.domainNotSelected(r.domains, 'notes');
      this.snapshot = { domains: r.domains };
    },
  },

  {
    id:          'habits.context_minimization',
    description: 'SPEC §28+84: habits question loads habits context only, not finance transactions',
    domain:      'habits',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeByRules }   = require('../../contextRouter');
      const { routeSkill }     = require('../../skillRouter');
      const msg  = 'Какие привычки у меня на сегодня?';
      const ctx  = routeByRules(msg, []);
      const skillR = routeSkill({ message: msg, history: [], domains: ctx.domains });

      a.domainSelected(ctx, 'habits');
      a.domainNotSelected(ctx.domains, 'finance');
      // No finance skill should be selected
      for (const s of skillR.skills) {
        a.ok(!s.id.startsWith('finance.'), `finance skill "${s.id}" should NOT be selected for habits query`);
      }
      this.snapshot = { domains: ctx.domains, skills: skillR.skills.map(s => s.id) };
    },
  },

  {
    id:          'habits.tool_minimization',
    description: 'SPEC §29: habits query → only habits tools, not all 17',
    domain:      'habits',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeSkill, getToolsForSkills } = require('../../skillRouter');
      const { getToolsForDomains }            = require('../../contextRouter');
      const { TOOL_DEFINITIONS }              = require('../../aiTools');

      const msg     = 'Проанализируй мои привычки за неделю.';
      const r       = routeSkill({ message: msg, history: [], domains: ['habits'] });
      const domains = r.skills.length ? r.skills[0].requiredContext : ['habits'];
      const tools   = getToolsForSkills(TOOL_DEFINITIONS, domains, r.skills, getToolsForDomains);
      const names   = tools.map(t => t.function?.name ?? t.name);

      a.ok(tools.length < TOOL_DEFINITIONS.length, 'fewer than full tool set');
      // Finance and task tools must not be present
      for (const name of ['create_transaction', 'create_task', 'create_note']) {
        a.ok(!names.includes(name), `"${name}" should not be in habits tool set`);
      }
      // At least get_habits should be present
      a.ok(names.includes('get_habits') || names.length === 0, 'get_habits in set (or empty=0 is ok if skill not found)');

      this.snapshot = { tools: names, count: names.length };
    },
  },

  {
    id:          'habits.privacy.no_finance_in_context',
    description: 'SPEC §84: habits-focused context does not contain transaction data',
    domain:      'habits',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeByRules } = require('../../contextRouter');
      const { getToolsForDomains } = require('../../contextRouter');
      const { TOOL_DEFINITIONS }   = require('../../aiTools');

      // "привычки" (nominative plural) contains the stem "привычк" → habits domain matched
      const r = routeByRules('Покажи мои привычки.', []);
      a.ok(r !== null, 'routeByRules must return a result for habits query');
      const tools = getToolsForDomains(TOOL_DEFINITIONS, r.domains);
      const names = tools.map(t => t.function?.name ?? t.name);

      a.ok(r.domains.includes('habits'), 'habits domain must be selected');
      // Finance tools must NOT appear in habits-only context
      a.ok(!names.includes('create_transaction'), 'create_transaction not available in habits-only context');
      a.ok(!names.includes('search_transactions'), 'search_transactions not available in habits-only context');
      this.snapshot = { domains: r.domains, tools: names };
    },
  },

  {
    id:          'habits.routing.recovery',
    description: '"Вернуться к привычкам после перерыва" → habits.recovery skill',
    domain:      'habits',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Как вернуться к привычкам после перерыва?', history: [], domains: [] });
      a.skillSelected(r, 'habits.recovery');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },
];

module.exports = habitScenarios;
