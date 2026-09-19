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
}
function teardownMockRates() {
  delete require.cache[require.resolve('../../exchangeRates')];
  delete require.cache[require.resolve('../../tools')];
}


// Mocks the FX service (the eval suite never hits Banki/CBR).
//   rates: { USD: 86 } → rateToRub per currency;  opts.fail → every lookup throws FxUnavailableError
const { FxUnavailableError: _FxErr } = require('../../fx');
const _FX_DEPENDENTS = ['../../tools', '../../transactions/financialTransaction'];
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


const currencyScenarios = [
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

module.exports = [...currencyScenarios];
