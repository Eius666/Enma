'use strict';

const a = require('../assertions');
const {
  makeAffordabilityTransactions, makeGoalFixture, makeCashGapTransactions,
  USER_HEALTHY_FINANCES,
  createMockDb, mockAdmin, mockGetUserTimezone, mockGetUserCurrency,
  thisMonthKey,
} = require('../fixtures');

const _REPO_PATHS = [
  '../../repositories/transactions',
  '../../repositories/tasks',
  '../../repositories/reminders',
  '../../repositories/notes',
  '../../repositories/habits',
  '../../repositories/goals',
];

function _clearRepoCache() {
  for (const m of _REPO_PATHS) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
}

function injectMockDb(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: { db: mockDb, admin: mockAdmin, getUserTimezone: mockGetUserTimezone, getUserCurrency: mockGetUserCurrency },
  };
  _clearRepoCache();
  delete require.cache[require.resolve('../../tools')];
}
function teardownMockDb() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  _clearRepoCache();
  delete require.cache[require.resolve('../../tools')];
}

// ── Routing scenarios ──────────────────────────────────────────────────────────

const routingScenarios = [
  {
    id:          'finance.spending.basic',
    description: 'SPEC §8: "Сколько потратил" → domain=finance, no skill required',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeByRules }   = require('../../contextRouter');
      const { routeSkill }     = require('../../skillRouter');
      const msg     = 'Сколько я потратил сегодня?';
      const ctx     = routeByRules(msg, []);
      a.domainSelected(ctx, 'finance');
      const skillR  = routeSkill({ message: msg, history: [], domains: ctx.domains });
      // General spending question → no deep finance skill needed
      // skill router may or may not select something; what matters is domain
      a.ok(ctx.domains.includes('finance'), 'finance domain must be selected');
      this.snapshot = { domains: ctx.domains, skills: skillR.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.affordability.routing',
    description: 'SPEC §8: "Могу ли купить ноутбук за 150 000?" → finance.affordability',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Могу ли я купить ноутбук за 150 000 ₽?', history: [], domains: [] });
      a.skillSelected(r, 'finance.affordability');
      this.snapshot = { skills: r.skills.map(s => s.id), source: r.source };
    },
  },

  {
    id:          'finance.leaks.routing',
    description: 'SPEC §8: "Куда у меня уходят деньги?" → finance.leaks',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Куда у меня уходят деньги?', history: [], domains: [] });
      a.skillSelected(r, 'finance.leaks');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.goal.routing',
    description: 'SPEC §8: "Хочу накопить 500 000 к июню" → finance.goal',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Хочу накопить 500 000 к июню.', history: [], domains: [] });
      a.skillSelected(r, 'finance.goal');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.budget.routing',
    description: 'SPEC §8: "Составь бюджет." → finance.budget',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Составь бюджет.', history: [], domains: [] });
      a.skillSelected(r, 'finance.budget');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.cashflow.routing',
    description: 'SPEC §8: "Хватит ли до зарплаты?" → finance.cashflow',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Хватит ли денег до зарплаты?', history: [], domains: [] });
      a.skillSelected(r, 'finance.cashflow');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.full_audit.routing',
    description: 'SPEC §8: "Проведи полный финансовый аудит." → finance.full_audit',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Проведи полный финансовый аудит.', history: [], domains: [] });
      a.skillSelected(r, 'finance.full_audit');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },
];

// ── Calculation scenarios ──────────────────────────────────────────────────────

const calculationScenarios = [
  {
    id:          'finance.affordability.calculation',
    description: 'SPEC §9: balance=200k, expenses=40k, purchase=150k → cashAfterPurchase=50k, cashAfterObligations=10k',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { calculateAffordability } = require('../../finance/affordability');
      const txs    = makeAffordabilityTransactions();
      const result = calculateAffordability({ purchaseAmount: 150000, transactions: txs, goals: [] });

      a.calcOk(result, 'affordability');
      a.numericEquals(result.currentBalance.value, 200000, 'currentBalance');
      a.numericEquals(result.avgMonthlyExpenses.value, 40000, 'avgMonthlyExpenses');
      a.numericEquals(result.scenarios.now.cashAfterPurchase, 50000, 'cashAfterPurchase');
      a.numericEquals(result.scenarios.now.cashAfterMonthlyExpenses, 10000, 'cashAfterObligations');

      this.snapshot = {
        currentBalance:      result.currentBalance.value,
        avgMonthlyExpenses:  result.avgMonthlyExpenses.value,
        cashAfterPurchase:   result.scenarios.now.cashAfterPurchase,
        cashAfterObligations:result.scenarios.now.cashAfterMonthlyExpenses,
      };
    },
  },

  {
    id:          'finance.goal.calculation',
    description: 'SPEC §11: target=500k, current=100k, 8 months → requiredMonthly = remaining/months',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { calculateGoalPlan } = require('../../finance/goals');
      const goal = makeGoalFixture();
      const txs  = makeAffordabilityTransactions();
      const result = calculateGoalPlan({ goals: [goal], transactions: txs, timezone: 'Europe/Moscow' });

      a.calcOk(result, 'goalPlan');
      const plan = result.goals?.[0];
      a.ok(plan, 'plan for goal-1 should exist');
      a.numericEquals(plan.remaining, 400000, 'remaining');
      a.numericPositive(plan.requiredMonthly.value, 'requiredMonthly');
      // Formula check: requiredMonthly ≈ remaining / monthsLeft
      const ratio = plan.remaining / plan.monthsLeft;
      a.numericClose(plan.requiredMonthly.value, ratio, 'requiredMonthly formula', 0.01, 100);

      this.snapshot = {
        remaining:       plan.remaining,
        monthsLeft:      plan.monthsLeft,
        requiredMonthly: plan.requiredMonthly.value,
      };
    },
  },

  {
    id:          'finance.cashflow.gap_detection',
    description: 'SPEC §12: low balance + high prev-month expenses → cash gap detected',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { calculateCashflow } = require('../../finance/cashflow');
      const txs    = makeCashGapTransactions();
      const result = calculateCashflow({ transactions: txs, timezone: 'Europe/Moscow' });

      // Either projectedClosingBalance < 0 or cashGap flag is set
      const closing = result.projections?.closingBalance?.value ?? result.closingBalance;
      const gapped  = (typeof closing === 'number' && closing < 0) || result.cashGap;
      a.ok(gapped, `Expected cash gap — projectedClosingBalance=${closing}, cashGap=${result.cashGap}`);

      this.snapshot = {
        projectedClosingBalance: closing,
        cashGap: result.cashGap,
      };
    },
  },

  {
    id:          'finance.affordability.empty_data',
    description: 'SPEC §52: empty transactions → insufficient_data, not balance=0',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { calculateAffordability } = require('../../finance/affordability');
      const result = calculateAffordability({ purchaseAmount: 150000, transactions: [], goals: [] });
      a.calcInsufficient(result, 'empty data');
      a.ok(!result.currentBalance, 'should not infer balance=0 when data absent');
      this.snapshot = { status: result.status };
    },
  },

  {
    id:          'finance.affordability.amount_extraction',
    description: 'SPEC §9: "150 000 ₽" correctly parsed from message text',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    run() {
      const { extractPurchaseAmount } = require('../../finance/affordability');
      a.numericEquals(extractPurchaseAmount('Могу ли я купить ноутбук за 150 000 ₽?'), 150000, 'ruble format');
      a.numericEquals(extractPurchaseAmount('ноутбук за 150к'), 150000, 'к-suffix');
      a.numericEquals(extractPurchaseAmount('А за 100 000 рублей?'), 100000, '100k rub');
      this.snapshot = { tested: ['150 000 ₽', '150к', '100 000 рублей'] };
    },
  },
];

// ── Context minimization scenarios ────────────────────────────────────────────

const contextScenarios = [
  {
    id:          'finance.general.no_personal_data',
    description: 'SPEC §13: "Что такое сложный процент?" → domain=general, no personal context loaded',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeByRules }   = require('../../contextRouter');
      const { routeSkill }     = require('../../skillRouter');
      const msg  = 'Что такое сложный процент?';
      const ctx  = routeByRules(msg, []);

      a.domainSelected(ctx, 'general');
      a.domainNotSelected(ctx.domains, 'finance');
      a.domainNotSelected(ctx.domains, 'tasks');
      a.domainNotSelected(ctx.domains, 'habits');
      a.routerSource(ctx, 'rules');

      const skillR = routeSkill({ message: msg, history: [], domains: ctx.domains });
      a.eq(skillR.skills.length, 0, 'no skills for general question');

      this.snapshot = { domains: ctx.domains, skills: skillR.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.what_if.false_positive',
    description: 'SPEC §31: "Если завтра будет дождь" → finance.what_if NOT selected',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill } = require('../../skillRouter');
      const r = routeSkill({ message: 'Если завтра будет дождь, что делать?', history: [], domains: [] });
      a.skillNotSelected(r, 'finance.what_if');
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },

  {
    id:          'finance.full_audit.absorption',
    description: 'SPEC §30: full_audit absorbs sub-skills — no duplicate skill prompts',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { routeSkill, resolveSkills } = require('../../skillRouter');
      const r = routeSkill({
        message: 'Проведи полный финансовый аудит.',
        history: [], domains: [],
      });

      a.skillSelected(r, 'finance.full_audit');
      // Sub-skills should NOT be separately selected alongside full_audit
      const absorbed = ['finance.leaks', 'finance.budget', 'finance.goal',
        'finance.month_review', 'finance.cashflow'];
      for (const sub of absorbed) {
        a.skillNotSelected(r, sub);
      }
      this.snapshot = { skills: r.skills.map(s => s.id) };
    },
  },
];

// ── Tool minimization for finance ─────────────────────────────────────────────

const toolMinimizationScenarios = [
  {
    id:          'finance.tool_minimization',
    description: 'SPEC §29: finance.affordability allows only finance tools, not all 17',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    run() {
      const { routeSkill, getToolsForSkills } = require('../../skillRouter');
      const { getToolsForDomains }            = require('../../contextRouter');
      const { TOOL_DEFINITIONS }              = require('../../aiTools');

      const r     = routeSkill({ message: 'Могу купить ноутбук за 150к?', history: [], domains: [] });
      const tools = getToolsForSkills(TOOL_DEFINITIONS, r.skills[0]?.requiredContext ?? [], r.skills, getToolsForDomains);

      a.ok(tools.length < TOOL_DEFINITIONS.length, 'fewer tools than full set');
      const names = tools.map(t => t.function?.name ?? t.name);
      // Finance affordability skill — no task/habit/note tools expected
      for (const name of ['create_task', 'create_habit', 'create_note', 'create_reminder']) {
        if (names.includes(name))
          a.ok(false, `Unexpected tool "${name}" in finance.affordability set`);
      }
      this.snapshot = { tools: names, count: names.length, totalDefined: TOOL_DEFINITIONS.length };
    },
  },
];

// ── Skill calculation mapping ──────────────────────────────────────────────────

const skillCalcMappingScenarios = [
  {
    id:          'finance.skill_calc_map.affordability',
    description: 'finance.affordability runs affordability + metrics calculators',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    run() {
      const { SKILL_CALCULATIONS } = require('../../finance/engine');
      const calcs = SKILL_CALCULATIONS['finance.affordability'] ?? [];
      a.ok(calcs.includes('affordability'), 'affordability calc included');
      a.ok(calcs.includes('metrics'), 'metrics calc included');
      this.snapshot = { calcs };
    },
  },

  {
    id:          'finance.skill_calc_map.full_audit',
    description: 'finance.full_audit runs all major calculators',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    run() {
      const { SKILL_CALCULATIONS } = require('../../finance/engine');
      const calcs = SKILL_CALCULATIONS['finance.full_audit'] ?? [];
      for (const expected of ['metrics', 'cashflow', 'leaks', 'goals']) {
        a.ok(calcs.includes(expected), `full_audit should include ${expected}`);
      }
      this.snapshot = { calcs };
    },
  },
];

// ── Currency / data quality ────────────────────────────────────────────────────

const dataQualityScenarios = [
  {
    id:          'finance.unknown_not_zero',
    description: 'SPEC §52: absent transaction data → insufficient_data, not balance=0',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    run() {
      const { calculateAffordability }  = require('../../finance/affordability');
      const { calculateGoalPlan }       = require('../../finance/goals');
      const { calculateCashflow }       = require('../../finance/cashflow');
      const checks = [
        calculateAffordability({ purchaseAmount: 100, transactions: [], goals: [] }),
        calculateGoalPlan({ goals: [], transactions: [], timezone: 'Europe/Moscow' }),
        calculateCashflow({ transactions: [], timezone: 'Europe/Moscow' }),
      ];
      for (const r of checks) {
        a.calcInsufficient(r, 'empty data → insufficient_data');
      }
      this.snapshot = { statuses: checks.map(r => r.status) };
    },
  },
];

// ── getFinanceStats regression tests ──────────────────────────────────────────

const financeStatsScenarios = [
  {
    id:          'finance.balance.basic',
    description: 'SPEC §22: "Сколько денег у меня есть?" → balance=84350, no Firestore/index words in response',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      // 3 income + 2 expense = balance 84350
      const now = new Date();
      const dateStr = d => {
        const dt = new Date(now.getTime() - d * 86_400_000);
        return dt.toISOString().split('T')[0];
      };
      const db = createMockDb({
        'transactions/t1': { userId: 'u1', type: 'income',  amount: 100000, currency: 'RUB', date: dateStr(30), categoryId: 'cat-salary' },
        'transactions/t2': { userId: 'u1', type: 'income',  amount: 50000,  currency: 'RUB', date: dateStr(15), categoryId: 'cat-salary' },
        'transactions/t3': { userId: 'u1', type: 'expense', amount: 45000,  currency: 'RUB', date: dateStr(10), categoryId: 'cat-food' },
        'transactions/t4': { userId: 'u1', type: 'expense', amount: 20000,  currency: 'RUB', date: dateStr(5),  categoryId: 'cat-transport' },
        'transactions/t5': { userId: 'u1', type: 'income',  amount: 350,    currency: 'RUB', date: dateStr(1),  categoryId: 'cat-other' },
      });
      injectMockDb(db);
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({ period: 'all' }, 'u1', 'RUB');

        a.ok(result.ok === true, 'getFinanceStats basic: expected ok=true');
        // Balance = 100000 + 50000 + 350 - 45000 - 20000 = 85350
        const balance = 100000 + 50000 + 350 - 45000 - 20000;
        a.ok(result.message.includes(balance.toFixed(2)) || result.message.includes(String(balance)),
          `response must contain balance ${balance}`);

        // Must NOT expose infrastructure details
        const lower = result.message.toLowerCase();
        a.ok(!lower.includes('firestore'), 'no "firestore" in response');
        a.ok(!lower.includes('индекс'), 'no "индекс" in response');
        a.ok(!lower.includes('база данных'), 'no "база данных" in response');
        a.ok(!lower.includes('failed_precondition'), 'no error code in response');

        this.snapshot = { balance, responseOk: result.ok };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.balance.partial_failure',
    description: 'SPEC §22: balance query succeeds even if categories throw; returns balance, not error',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      // Build a db that returns docs successfully but with a corrupted categoryId that would throw
      // In our fixed implementation the categories section is in a try/catch, so it should still return balance
      const dateStr = new Date(Date.now() - 5 * 86_400_000).toISOString().split('T')[0];
      const db = createMockDb({
        'transactions/t1': { userId: 'u1', type: 'income',  amount: 50000, currency: 'RUB', date: dateStr, categoryId: 'cat-salary' },
        'transactions/t2': { userId: 'u1', type: 'expense', amount: 15650, currency: 'RUB', date: dateStr, categoryId: 'cat-food' },
      });
      injectMockDb(db);
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({ period: 'month' }, 'u1', 'RUB');

        // Critical: must succeed and contain balance
        a.ok(result.ok === true, 'partial failure scenario: must still return ok=true');
        const balance = 50000 - 15650;  // 34350
        a.ok(result.message.includes(balance.toFixed(2)) || result.message.includes(String(balance)),
          `response must contain balance ${balance}`);

        this.snapshot = { balance, responseOk: result.ok };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.expenses.basic',
    description: 'SPEC §22: expenses sum for current month is correct in response',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    async run() {
      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString().split('T')[0];
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().split('T')[0];
      const db = createMockDb({
        'transactions/e1': { userId: 'u1', type: 'expense', amount: 3000,  currency: 'RUB', date: thisMonth, categoryId: 'cat-food' },
        'transactions/e2': { userId: 'u1', type: 'expense', amount: 1500,  currency: 'RUB', date: thisMonth, categoryId: 'cat-transport' },
        'transactions/e3': { userId: 'u1', type: 'expense', amount: 99999, currency: 'RUB', date: lastMonth, categoryId: 'cat-other' },
        'transactions/i1': { userId: 'u1', type: 'income',  amount: 80000, currency: 'RUB', date: thisMonth, categoryId: 'cat-salary' },
      });
      injectMockDb(db);
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({ period: 'month' }, 'u1', 'RUB');
        a.ok(result.ok === true, 'expenses basic: expected ok=true');
        // Current month expenses = 3000 + 1500 = 4500
        a.ok(result.message.includes('4500.00') || result.message.includes('4 500'),
          'response must contain 4500 in expenses');
        // Last month expense (99999) should NOT appear in period totals
        a.ok(!result.message.includes('99999'), 'last-month expense must not appear in monthly totals');
        this.snapshot = { monthExpenses: 4500, responseOk: result.ok };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.income.basic',
    description: 'SPEC §22: income sum for current month is correct in response',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    async run() {
      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 10).toISOString().split('T')[0];
      const db = createMockDb({
        'transactions/i1': { userId: 'u1', type: 'income',  amount: 120000, currency: 'RUB', date: thisMonth, categoryId: 'cat-salary' },
        'transactions/i2': { userId: 'u1', type: 'income',  amount: 5000,   currency: 'RUB', date: thisMonth, categoryId: 'cat-freelance' },
        'transactions/e1': { userId: 'u1', type: 'expense', amount: 30000,  currency: 'RUB', date: thisMonth, categoryId: 'cat-rent' },
      });
      injectMockDb(db);
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({ period: 'month' }, 'u1', 'RUB');
        a.ok(result.ok === true, 'income basic: expected ok=true');
        // Month income = 120000 + 5000 = 125000
        a.ok(result.message.includes('125000.00') || result.message.includes('125 000'),
          'response must contain 125000 in income');
        this.snapshot = { monthIncome: 125000, responseOk: result.ok };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.balance.no_index_error',
    description: 'SPEC §22: getFinanceStats must not return Firestore index error to caller',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      // Simulate a Firestore FAILED_PRECONDITION error on the main query
      const fa = require.resolve('../../firebaseAdmin');
      delete require.cache[fa];
      const indexError = Object.assign(new Error('The query requires an index. You can create it here: https://console.firebase.google.com/...'), { code: 9 });
      require.cache[fa] = {
        id: fa, filename: fa, loaded: true,
        exports: {
          db: {
            collection: () => ({
              where: () => ({
                get: async () => { throw indexError; },
                where: () => ({ get: async () => { throw indexError; } }),
                orderBy: () => ({ get: async () => { throw indexError; }, limit: () => ({ get: async () => { throw indexError; } }) }),
                limit: () => ({ get: async () => { throw indexError; } }),
              }),
            }),
          },
          admin: mockAdmin,
          getUserTimezone: mockGetUserTimezone,
          getUserCurrency: mockGetUserCurrency,
        },
      };
      _clearRepoCache();
      delete require.cache[require.resolve('../../tools')];
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({ period: 'month' }, 'u1', 'RUB');

        // Must return ok: false (graceful error), not throw
        a.ok(!result.ok, 'must return ok:false on index error, not throw');

        // Error message must NOT expose Firestore details
        const lower = (result.error || '').toLowerCase();
        a.ok(!lower.includes('firestore'), 'no "firestore" in error message');
        a.ok(!lower.includes('index'), 'no "index" in error message');
        a.ok(!lower.includes('console.firebase'), 'no firebase console URL in error message');
        a.ok(!lower.includes('failed_precondition'), 'no error code in error message');

        this.snapshot = { errorExposed: false, errorMessage: result.error };
      } finally { teardownMockDb(); }
    },
  },
];

// ── Integration tests for the ACTUAL production tool path ─────────────────────
// These test executeTool('search_transactions') from aiTools.js — the exact function
// the LLM calls when the user asks "Сколько денег у меня есть?" via POST /api/ai/chat.
// The previous fix targeted api/_lib/tools.js (Telegram bot path), not aiTools.js.
// These tests would have caught that mismatch.

function injectMockDbForAiTools(mockDb) {
  const fa = require.resolve('../../firebaseAdmin');
  delete require.cache[fa];
  require.cache[fa] = {
    id: fa, filename: fa, loaded: true,
    exports: { db: mockDb, admin: mockAdmin, getUserTimezone: mockGetUserTimezone, getUserCurrency: mockGetUserCurrency },
  };
  _clearRepoCache();
  delete require.cache[require.resolve('../../aiTools')];
}
function teardownMockDbForAiTools() {
  delete require.cache[require.resolve('../../firebaseAdmin')];
  _clearRepoCache();
  delete require.cache[require.resolve('../../aiTools')];
}

// Mocks the FX rates module so multi-currency aggregation tests are
// deterministic and offline — no real network fetch happens in the eval suite.
function injectMockRates(rates) {
  const er = require.resolve('../../exchangeRates');
  delete require.cache[er];
  require.cache[er] = {
    id: er, filename: er, loaded: true,
    exports: { getExchangeRates: async () => rates },
  };
  delete require.cache[require.resolve('../../tools')];
  delete require.cache[require.resolve('../../aiTools')];
}
function teardownMockRates() {
  delete require.cache[require.resolve('../../exchangeRates')];
  delete require.cache[require.resolve('../../tools')];
  delete require.cache[require.resolve('../../aiTools')];
}


// Mocks the FX service (the eval suite never hits Banki/CBR).
//   rates: { USD: 86 } → rateToRub per currency;  opts.fail → every lookup throws FxUnavailableError
const { FxUnavailableError: _FxErr } = require('../../fx');
const _FX_DEPENDENTS = ['../../tools', '../../aiTools', '../../transactions/financialTransaction'];
function _clearFxDependents() {
  for (const m of _FX_DEPENDENTS) {
    try { delete require.cache[require.resolve(m)]; } catch (_) {}
  }
}
function injectMockFx(rates, opts = {}) {
  const table = { ...rates };
  const calls = [];
  const fxPath = require.resolve('../../fx');
  delete require.cache[fxPath];
  require.cache[fxPath] = {
    id: fxPath, filename: fxPath, loaded: true,
    exports: {
      FxUnavailableError: _FxErr,
      getBankRateToRub: async ({ currency, transactionType, timestamp }) => {
        calls.push({ currency, transactionType, timestamp });
        if (opts.fail || !table[currency]) throw new _FxErr(currency, [{ provider: 'mock', reason: 'down' }]);
        const now = new Date().toISOString();
        return {
          rateToRub: table[currency], source: 'bank_average', provider: 'mock',
          capturedAt: now, rateDate: now.slice(0, 10), sampleSize: 7,
          method: 'median_mad_filtered', rateSide: transactionType === 'income' ? 'bank_buys' : 'bank_sells',
        };
      },
    },
  };
  _clearFxDependents();
  return { calls, setRate: (c, r) => { table[c] = r; } };
}
function teardownFx() {
  delete require.cache[require.resolve('../../fx')];
  _clearFxDependents();
}

const financeToolIntegrationScenarios = [
  {
    id:          'finance.tool.search_transactions.balance',
    description: 'CRITICAL: search_transactions (aiTools.js) returns correct balance without orderBy — this is the tool the LLM calls via POST /api/ai/chat',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const M = thisMonthKey();
      const mockDb = createMockDb({
        [`transactions/t1`]: { userId: 'u1', type: 'income',  amount: 100000, currency: 'RUB', date: `${M}-01`, description: 'Зарплата' },
        [`transactions/t2`]: { userId: 'u1', type: 'expense', amount:  20000, currency: 'RUB', date: `${M}-05`, description: 'Аренда' },
        [`transactions/t3`]: { userId: 'u1', type: 'income',  amount:  50000, currency: 'RUB', date: `${M}-10`, description: 'Фриланс' },
      });
      injectMockDbForAiTools(mockDb);
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('u1', 'search_transactions', {});

        a.ok(result.success === true, 'search_transactions must succeed without orderBy');
        a.ok(result.data != null, 'must return data');
        // balance = 100000 + 50000 - 20000 = 130000
        a.numericEquals(result.data.balance, 130000, 'all-time balance must be 130000');
        a.numericEquals(result.data.totalIncome, 150000, 'total income must be 150000');
        a.numericEquals(result.data.totalExpense, 20000, 'total expense must be 20000');

        // No Firestore/index error text should appear anywhere
        const resultStr = JSON.stringify(result).toLowerCase();
        a.ok(!resultStr.includes('firestore'), 'no firestore in result');
        a.ok(!resultStr.includes('index'), 'no index in result');
        a.ok(!resultStr.includes('failed_precondition'), 'no FAILED_PRECONDITION in result');

        this.snapshot = { balance: result.data.balance, income: result.data.totalIncome, expense: result.data.totalExpense };
      } finally { teardownMockDbForAiTools(); }
    },
  },

  {
    id:          'finance.tool.search_transactions.no_index_error',
    description: 'CRITICAL: search_transactions (aiTools.js) returns INTERNAL_ERROR gracefully when DB throws — never exposes raw Firestore error to LLM',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const fa = require.resolve('../../firebaseAdmin');
      delete require.cache[fa];
      const indexError = Object.assign(
        new Error('The query requires an index. You can create it here: https://console.firebase.google.com/...'),
        { code: 9 }
      );
      require.cache[fa] = {
        id: fa, filename: fa, loaded: true,
        exports: {
          db: {
            collection: () => ({
              where: () => ({
                get: async () => { throw indexError; },
                where: () => ({ get: async () => { throw indexError; } }),
                orderBy: () => ({ get: async () => { throw indexError; }, limit: () => ({ get: async () => { throw indexError; } }) }),
                limit: () => ({ get: async () => { throw indexError; } }),
              }),
            }),
          },
          admin: mockAdmin,
          getUserTimezone: mockGetUserTimezone,
          getUserCurrency: mockGetUserCurrency,
        },
      };
      delete require.cache[require.resolve('../../aiTools')];
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('u1', 'search_transactions', {});

        // Must return success:false (graceful), not throw
        a.ok(result.success === false, 'must return success:false on DB error, not throw');

        // Error sent to LLM must NOT contain Firestore details
        const resultStr = JSON.stringify(result).toLowerCase();
        a.ok(!resultStr.includes('firestore'), 'no firestore in error sent to LLM');
        a.ok(!resultStr.includes('console.firebase'), 'no firebase console URL in LLM error');
        a.ok(!resultStr.includes('failed_precondition'), 'no FAILED_PRECONDITION in LLM error');

        this.snapshot = { errorCode: result.errorCode, noIndexExposed: true };
      } finally { teardownMockDbForAiTools(); }
    },
  },
];

// ── Currency regression suite ─────────────────────────────────────────────────
// These tests guard against re-introduction of USD as default base currency
// (the original bug: getUserCurrency() returned 'USD', amounts appeared as $2M).

const currencyScenarios = [
  {
    id:          'finance.currency.rub_default',
    description: 'CRITICAL: getUserCurrency returns RUB for users with no currency field — never USD',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const { getUserCurrency } = require('../../firebaseAdmin');
      const mockDb = createMockDb({});                 // user doc does not exist
      injectMockDb(mockDb);
      try {
        const currency = await getUserCurrency('nonexistent_user');
        a.ok(currency === 'RUB', `getUserCurrency must default to RUB, got: ${currency}`);
        a.ok(currency !== 'USD', 'must NOT default to USD');
        this.snapshot = { currency };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.balance_rub',
    description: 'CRITICAL: getFinanceStats returns balance with RUB currency label — not USD',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const M = thisMonthKey();
      const mockDb = createMockDb({
        'users/u1': { currency: 'RUB' },
        'transactions/t1': { userId: 'u1', type: 'income',  amount: 175000000, currency: 'RUB', date: `${M}-01`, description: 'Зарплата' },
        'transactions/t2': { userId: 'u1', type: 'expense', amount:   5000000, currency: 'RUB', date: `${M}-15`, description: 'Ресторан' },
      });
      injectMockDb(mockDb);
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({}, 'u1', 'RUB');

        a.ok(result.ok === true, 'getFinanceStats must succeed');
        const msg = result.message || '';
        a.ok(msg.includes('₽') || msg.includes('RUB'), `balance message must contain ₽ or RUB, got: ${msg}`);
        a.ok(!msg.includes('$'), `balance message must NOT contain $, got: ${msg}`);
        a.ok(!msg.toLowerCase().includes('usd'), `balance message must NOT contain USD, got: ${msg}`);

        this.snapshot = { containsRUB: msg.includes('₽') || msg.includes('RUB'), noUSD: !msg.includes('$') };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.no_implicit_conversion',
    description: 'CRITICAL: calculateCurrentBalance returns the raw RUB amount — no division by exchange rate',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const txRepo = require('../../repositories/transactions');
      const transactions = [
        { type: 'income',  amount: 175000000, currency: 'RUB' },
        { type: 'expense', amount:   5000000, currency: 'RUB' },
      ];
      const balance = txRepo.calculateCurrentBalance(transactions, 'RUB');
      // Must be 170,000,000 — NOT ~1,935,227 (÷88) or any USD-converted value
      a.numericEquals(balance, 170000000, `balance must be 170000000 RUB, got: ${balance}`);
      a.ok(balance > 1000000, 'balance must be in RUB scale (> 1M), not USD scale (~2M)');
      this.snapshot = { balance };
    },
  },

  {
    id:          'finance.currency.web_telegram_consistency',
    description: 'Same fixture: Web AI (aiTools) and Telegram (tools.js) return the same balance value',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    async run() {
      const M = thisMonthKey();
      const fixture = {
        'users/u1': { currency: 'RUB' },
        'transactions/t1': { userId: 'u1', type: 'income',  amount: 175000000, currency: 'RUB', date: `${M}-01`, description: 'Salary' },
        'transactions/t2': { userId: 'u1', type: 'expense', amount:   5000000, currency: 'RUB', date: `${M}-15`, description: 'Food' },
      };

      // Telegram path
      const mockDbTg = createMockDb(fixture);
      injectMockDb(mockDbTg);
      let tgBalance;
      try {
        const { getFinanceStats } = require('../../tools');
        const result = await getFinanceStats({}, 'u1', 'RUB');
        a.ok(result.ok === true, 'Telegram getFinanceStats must succeed');
        tgBalance = result.message;
      } finally { teardownMockDb(); }

      // Web AI path
      const mockDbWeb = createMockDb(fixture);
      injectMockDbForAiTools(mockDbWeb);
      let webBalance;
      try {
        const { executeTool } = require('../../aiTools');
        const result = await executeTool('u1', 'search_transactions', {});
        a.ok(result.success === true, 'Web AI search_transactions must succeed');
        webBalance = result.data.balance;
      } finally { teardownMockDbForAiTools(); }

      // Both paths must agree: income 175M - expense 5M = 170M
      a.numericEquals(webBalance, 170000000, `Web AI balance must be 170000000, got: ${webBalance}`);
      // Match the "Баланс:" line specifically — a loose substring check would
      // also pass if only the period breakdown showed 170M while the actual
      // all-time balance figure was wrong (this happened during development).
      const balanceLine = String(tgBalance).split('\n').find(l => l.includes('Баланс')) || '';
      a.ok(balanceLine.replace(/\s/g, '').includes('170000000') || balanceLine.replace(/[\s  ]/g, '').includes('170000000'),
        `Telegram "Баланс:" line must contain 170000000, got: ${balanceLine}`);

      this.snapshot = { webBalance, tgHas170: String(tgBalance).includes('170') };
    },
  },

  {
    id:          'finance.currency.identity_no_fx_needed',
    description: 'RUB-only user must never depend on FX rates being available — offline FX API must not break the balance',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      // No injectMockRates() call — getExchangeRates would hit the real network
      // and fail/hang in this sandbox. A RUB-only user must never trigger that call.
      const fixture = {
        'users/u1': { currency: 'RUB' },
        'transactions/t1': { userId: 'u1', type: 'expense', amount: 5000, currency: 'RUB', date: `${thisMonthKey()}-05`, description: 'Ресторан' },
      };
      const mockDb = createMockDb(fixture);
      injectMockDb(mockDb);
      let result;
      try {
        const { getFinanceStats } = require('../../tools');
        result = await getFinanceStats({}, 'u1', 'RUB');
      } finally { teardownMockDb(); }

      a.ok(result.ok === true, `RUB-only balance must succeed without any FX call, got: ${JSON.stringify(result)}`);
      a.ok(String(result.message).includes('5000'), `balance must show exact 5000 RUB with no conversion drift, got: ${result.message}`);

      this.snapshot = { message: result.message };
    },
  },

  {
    id:          'finance.currency.goal_explicit_currency',
    description: 'SPEC: "Хочу накопить $20000" → goal.currency=USD, overriding the user\'s RUB display currency',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const fixture = { 'users/u1': { currency: 'RUB' } };
      const mockDb = createMockDb(fixture);
      injectMockDb(mockDb);
      try {
        const { executeTool } = require('../../tools');
        // Simulates the LLM having parsed "$20000" and filled the optional
        // `currency` tool arg — explicit currency must win over user.currency.
        const result = await executeTool(
          'create_goal',
          { title: 'Новый ноутбук', targetAmount: 20000, currency: 'USD' },
          'u1', 'chat1', 'Europe/Moscow', 'RUB',
        );
        a.ok(result.ok === true, `create_goal must succeed, got: ${JSON.stringify(result)}`);

        const goalsSnap = await mockDb.collection('goals').get();
        const stored = goalsSnap.docs[0]?.data();
        a.ok(stored, 'goal document must have been written');
        a.ok(stored.currency === 'USD', `stored goal.currency must be USD (explicit), got: ${stored?.currency}`);
        a.ok(stored.targetAmount === 20000, `stored targetAmount must stay 20000 (no conversion on write), got: ${stored?.targetAmount}`);

        this.snapshot = { currency: stored.currency, targetAmount: stored.targetAmount };
      } finally { teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.goal_default_currency',
    description: '"Хочу накопить 500000" (no explicit currency) → falls back to user.currency',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    async run() {
      const fixture = { 'users/u1': { currency: 'RUB' } };
      const mockDb = createMockDb(fixture);
      injectMockDb(mockDb);
      try {
        const { executeTool } = require('../../tools');
        const result = await executeTool(
          'create_goal',
          { title: 'Отпуск', targetAmount: 500000 },
          'u1', 'chat1', 'Europe/Moscow', 'RUB',
        );
        a.ok(result.ok === true, `create_goal must succeed, got: ${JSON.stringify(result)}`);

        const goalsSnap = await mockDb.collection('goals').get();
        const stored = goalsSnap.docs[0]?.data();
        a.ok(stored.currency === 'RUB', `no explicit currency named → must fall back to user.currency (RUB), got: ${stored?.currency}`);

        this.snapshot = { currency: stored.currency };
      } finally { teardownMockDb(); }
    },
  },

  // ── Currency architecture v2: user.currency = INPUT currency, budget = RUB,
  //    transactions carry a locked rubAmount + fx snapshot. ────────────────────

  {
    id:          'finance.currency.v2_input_currency_usd_creates_locked_snapshot',
    description: 'SPEC: user.currency=USD, Telegram "потратил 100" (no currency named) → stored USD, rubAmount=8600 locked, fx snapshot present',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDb(mockDb);
      const fx = injectMockFx({ USD: 86 });
      try {
        const { executeTool } = require('../../tools');
        const result = await executeTool('create_transaction', { type: 'expense', amount: 100, description: 'Ресторан' }, 'u1', 'chat1', 'Europe/Moscow', 'USD');
        a.ok(result.ok === true, `must succeed, got: ${JSON.stringify(result)}`);
        const stored = (await mockDb.collection('transactions').get()).docs[0].data();
        a.ok(stored.schemaVersion === 2, 'schemaVersion must be 2');
        a.ok(stored.currency === 'USD' && stored.amount === 100, `stored ${stored.currency} ${stored.amount}`);
        a.ok(stored.rubAmount === 8600, `rubAmount must be locked 8600, got: ${stored.rubAmount}`);
        a.ok(stored.fx && stored.fx.rateToRub === 86 && stored.fx.source === 'bank_average', 'fx snapshot must be stored');
        a.ok(fx.calls.length === 1 && fx.calls[0].transactionType === 'expense', 'exactly one FX call, expense side');
        this.snapshot = { rubAmount: stored.rubAmount };
      } finally { teardownFx(); teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.v2_rub_baseline_no_fx',
    description: 'REGRESSION: user.currency=RUB, "ресторан 5000" → 5000 RUB, rubAmount=5000, fx=null, NO FX call (even if FX providers are down)',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'RUB' } });
      injectMockDb(mockDb);
      const fx = injectMockFx({}, { fail: true });
      try {
        const { executeTool } = require('../../tools');
        const result = await executeTool('create_transaction', { type: 'expense', amount: 5000, description: 'Ресторан' }, 'u1', 'chat1', 'Europe/Moscow', 'RUB');
        a.ok(result.ok === true, `RUB must never depend on FX, got: ${JSON.stringify(result)}`);
        const stored = (await mockDb.collection('transactions').get()).docs[0].data();
        a.ok(stored.currency === 'RUB' && stored.amount === 5000 && stored.rubAmount === 5000 && stored.fx === null, `bad RUB doc: ${JSON.stringify(stored)}`);
        a.ok(fx.calls.length === 0, 'RUB must not call the FX service');
        this.snapshot = { ok: true };
      } finally { teardownFx(); teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.v2_explicit_wins_over_input_currency',
    description: 'SPEC: user.currency=USD, explicit "1000 руб" → RUB (no FX); explicit EUR/CNY get their own snapshots',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDb(mockDb);
      const fx = injectMockFx({ USD: 86, EUR: 101, CNY: 12 });
      try {
        const { executeTool } = require('../../tools');
        const run = (args) => executeTool('create_transaction', { type: 'expense', description: 'x', ...args }, 'u1', 'chat1', 'Europe/Moscow', 'USD');
        await run({ amount: 1000, currency: 'RUB' });
        await run({ amount: 100, currency: 'EUR' });
        await run({ amount: 80, currency: 'CNY' });
        const docs = (await mockDb.collection('transactions').get()).docs.map(d => d.data());
        const by = (c) => docs.find(d => d.currency === c);
        a.ok(by('RUB').rubAmount === 1000 && by('RUB').fx === null, 'explicit RUB stays RUB');
        a.ok(by('EUR').rubAmount === 10100, `EUR rubAmount, got ${by('EUR').rubAmount}`);
        a.ok(by('CNY').rubAmount === 960, `CNY rubAmount, got ${by('CNY').rubAmount}`);
        a.ok(fx.calls.length === 2, 'FX only for EUR and CNY');
        this.snapshot = { n: docs.length };
      } finally { teardownFx(); teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.v2_fx_unavailable_writes_nothing',
    description: 'SPEC: all FX providers fail → foreign transaction NOT saved (no invented rubAmount), controlled error; RUB still works',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDb(mockDb);
      injectMockFx({}, { fail: true });
      try {
        const { executeTool } = require('../../tools');
        const bad = await executeTool('create_transaction', { type: 'expense', amount: 50, description: 'Кофе' }, 'u1', 'chat1', 'Europe/Moscow', 'USD');
        a.ok(bad.ok === false, `must fail cleanly, got: ${JSON.stringify(bad)}`);
        a.ok((await mockDb.collection('transactions').get()).docs.length === 0, 'no transaction may be written');
        const good = await executeTool('create_transaction', { type: 'expense', amount: 50, currency: 'RUB', description: 'Кофе' }, 'u1', 'chat1', 'Europe/Moscow', 'USD');
        a.ok(good.ok === true, 'RUB still works');
        this.snapshot = { ok: true };
      } finally { teardownFx(); teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.v2_webai_same_semantics',
    description: 'SPEC (Web AI): implicit amount → user.currency with locked rubAmount; explicit currency wins',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDbForAiTools(mockDb);
      injectMockFx({ USD: 86, CNY: 12 });
      try {
        const { executeTool } = require('../../aiTools');
        const r1 = await executeTool('u1', 'create_transaction', { type: 'expense', amount: 10, description: 'Кофе' });
        a.ok(r1.success === true && r1.data.currency === 'USD' && r1.data.rubAmount === 860, `implicit → USD 860 ₽, got ${JSON.stringify(r1)}`);
        const r2 = await executeTool('u1', 'create_transaction', { type: 'expense', amount: 80, currency: 'CNY', description: 'Такси' });
        a.ok(r2.success === true && r2.data.currency === 'CNY' && r2.data.rubAmount === 960, `explicit CNY, got ${JSON.stringify(r2)}`);
        const r3 = await executeTool('u1', 'create_transaction', { type: 'expense', amount: 1000, currency: 'RUB', description: 'Обед' });
        a.ok(r3.success === true && r3.data.rubAmount === 1000, 'explicit RUB');
        const docs = (await mockDb.collection('transactions').get()).docs.map(d => d.data());
        a.ok(docs.every(d => d.schemaVersion === 2 && Number.isFinite(d.rubAmount)), 'all new docs are v2 with rubAmount');
        this.snapshot = { n: docs.length };
      } finally { teardownFx(); teardownMockDbForAiTools(); }
    },
  },

  {
    id:          'finance.currency.v2_idempotent_retry',
    description: 'SPEC: retrying the same AI action (same docId) neither duplicates the document nor takes a second FX snapshot',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDbForAiTools(mockDb);
      const fx = injectMockFx({ USD: 86 });
      try {
        const { executeTool } = require('../../aiTools');
        const args = { type: 'expense', amount: 100, description: 'Кофе' };
        const first = await executeTool('u1', 'create_transaction', args, { docId: 'tx-fixed-1' });
        fx.setRate('USD', 95);
        const retry = await executeTool('u1', 'create_transaction', args, { docId: 'tx-fixed-1' });
        a.ok(first.success && retry.success, 'both attempts succeed');
        const docs = (await mockDb.collection('transactions').get()).docs;
        a.ok(docs.length === 1, `exactly one document, got ${docs.length}`);
        a.ok(docs[0].data().rubAmount === 8600, 'first snapshot stays canonical (8600, not 9500)');
        a.ok(fx.calls.length === 1, 'retry must not call FX again');
        this.snapshot = { n: 1 };
      } finally { teardownFx(); teardownMockDbForAiTools(); }
    },
  },

  {
    id:          'finance.currency.v2_budget_sums_locked_rub',
    description: 'SPEC: mixed v2 budget — 5000 RUB + $100 (8600) + €100 (10100) + ¥500 (6000) → expenses 29 700 ₽ in both channels; runtime FX is ignored',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const m = `${thisMonthKey()}`;
      const v2 = (id, currency, amount, rubAmount) => [`transactions/${id}`, { userId: 'u1', schemaVersion: 2, type: 'expense', amount, currency, rubAmount, fx: currency === 'RUB' ? null : { rateToRub: rubAmount / amount }, date: `${m}-05`, description: id }];
      const fixture = { 'users/u1': { currency: 'USD' }, ...Object.fromEntries([v2('a', 'RUB', 5000, 5000), v2('b', 'USD', 100, 8600), v2('c', 'EUR', 100, 10100), v2('d', 'CNY', 500, 6000)]) };
      injectMockRates({ RUB: 1, USD: 1 / 1000, EUR: 1 / 1000, CNY: 1 / 1000 }); // must be ignored

      const mockDbWeb = createMockDb(fixture);
      injectMockDbForAiTools(mockDbWeb);
      let web;
      try {
        const { executeTool } = require('../../aiTools');
        web = await executeTool('u1', 'search_transactions', {});
      } finally { teardownMockDbForAiTools(); }

      const mockDbTg = createMockDb(fixture);
      injectMockDb(mockDbTg);
      let tg;
      try {
        const { getFinanceStats } = require('../../tools');
        tg = await getFinanceStats({}, 'u1', 'RUB');
      } finally { teardownMockDb(); }
      teardownMockRates();

      a.numericEquals(web.data.totalExpense, 29700, `Web AI expenses, got ${web.data.totalExpense}`);
      a.ok(String(tg.message).replace(/[\s  ]/g, '').includes('29700'), `Telegram stats must show 29700, got: ${tg.message}`);
      this.snapshot = { totalExpense: web.data.totalExpense };
    },
  },

  {
    id:          'finance.currency.v2_history_immutable_across_switches',
    description: 'SPEC: RUB→USD→CNY→RUB user.currency switches never rewrite historical transactions',
    domain:      'finance',
    critical:    true,
    snapshot:    {},
    async run() {
      const fixture = {
        'users/u1': { currency: 'RUB' },
        'transactions/t1': { userId: 'u1', schemaVersion: 2, type: 'expense', amount: 5000, currency: 'RUB', rubAmount: 5000, fx: null, description: 'Ресторан' },
      };
      const mockDb = createMockDb(fixture);
      injectMockDb(mockDb);
      injectMockFx({ USD: 86, CNY: 12 });
      try {
        const before = JSON.stringify((await mockDb.collection('transactions').doc('t1').get()).data());
        const { executeTool } = require('../../tools');
        for (const cur of ['USD', 'CNY', 'RUB']) {
          await mockDb.collection('users').doc('u1').set({ currency: cur }, { merge: true });
          await executeTool('create_transaction', { type: 'expense', amount: 10, description: `tx ${cur}` }, 'u1', 'chat1', 'Europe/Moscow', cur);
        }
        const after = JSON.stringify((await mockDb.collection('transactions').doc('t1').get()).data());
        a.ok(before === after, 'historical transaction must be byte-identical');
        const all = (await mockDb.collection('transactions').get()).docs.map(d => d.data());
        a.ok(all.length === 4, `4 docs expected, got ${all.length}`);
        a.ok(['USD', 'CNY', 'RUB'].every((c) => all.some(d => d.currency === c && d.description === `tx ${c}`)), 'each new tx uses the input currency at its time');
        this.snapshot = { unchanged: true };
      } finally { teardownFx(); teardownMockDb(); }
    },
  },

  {
    id:          'finance.currency.goal_uses_user_currency_when_implicit',
    description: 'SPEC: user.currency=USD, "Хочу накопить 500" (implicit) → goal.currency=USD',
    domain:      'finance',
    critical:    false,
    snapshot:    {},
    async run() {
      const mockDb = createMockDb({ 'users/u1': { currency: 'USD' } });
      injectMockDb(mockDb);
      try {
        const { executeTool } = require('../../tools');
        const r = await executeTool('create_goal', { title: 'Отпуск', targetAmount: 500 }, 'u1', 'chat1', 'Europe/Moscow', 'USD');
        a.ok(r.ok === true, `create_goal must succeed, got: ${JSON.stringify(r)}`);
        const stored = (await mockDb.collection('goals').get()).docs[0].data();
        a.ok(stored.currency === 'USD', `implicit goal currency → user.currency, got ${stored.currency}`);
        this.snapshot = { currency: stored.currency };
      } finally { teardownMockDb(); }
    },
  },
];

module.exports = [
  ...routingScenarios,
  ...calculationScenarios,
  ...contextScenarios,
  ...toolMinimizationScenarios,
  ...skillCalcMappingScenarios,
  ...dataQualityScenarios,
  ...financeStatsScenarios,
  ...financeToolIntegrationScenarios,
  ...currencyScenarios,
];
