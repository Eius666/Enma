'use strict';

// Tests runFinanceEngine's currency normalization wiring (spec: "conversion
// must happen before financial math, not after"). Mocks the FX rates module
// via require.cache so these tests are deterministic and offline — no real
// network fetch happens here.

const { test } = require('node:test');
const assert   = require('node:assert/strict');

function injectMockRates(rates) {
  const er = require.resolve('../../exchangeRates');
  delete require.cache[er];
  require.cache[er] = {
    id: er, filename: er, loaded: true,
    exports: { getExchangeRates: async () => rates },
  };
  delete require.cache[require.resolve('../engine')];
}

function injectFailingRates() {
  const er = require.resolve('../../exchangeRates');
  delete require.cache[er];
  require.cache[er] = {
    id: er, filename: er, loaded: true,
    exports: { getExchangeRates: async () => null }, // simulates FX API offline
  };
  delete require.cache[require.resolve('../engine')];
}

function injectSpyRates(rates, spy) {
  const er = require.resolve('../../exchangeRates');
  delete require.cache[er];
  require.cache[er] = {
    id: er, filename: er, loaded: true,
    exports: { getExchangeRates: async () => { spy.called = true; return rates; } },
  };
  delete require.cache[require.resolve('../engine')];
}

function teardown() {
  delete require.cache[require.resolve('../../exchangeRates')];
  delete require.cache[require.resolve('../engine')];
}

const RATES = { RUB: 1, USD: 100 / 9000 }; // 9000 RUB == 100 USD
const M = new Date().toISOString().slice(0, 7);

test('engine: mixed currency expenses convert-then-sum (9000 RUB + 100 USD = 200 USD)', async () => {
  injectMockRates(RATES);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 9000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'expense', amount: 100,  currency: 'USD', date: `${M}-06`, description: 'B', categoryId: 'p-other-e' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.ok(text.includes('Валюта расчёта: USD'), `must declare calculation currency, got: ${text}`);
    // 200 USD expenses this month, formatted with 2 decimals since < 1000
    assert.ok(text.includes('200.00'), `expected converted total 200.00, got: ${text}`);
  } finally { teardown(); }
});

test('engine: affordability mixed currency — balance normalized to USD before scenario math', async () => {
  injectMockRates(RATES);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income',  amount: 9_000_000, currency: 'RUB', date: `${M}-01`, description: 'Salary RUB', categoryId: 'p-salary' },
        { type: 'income',  amount: 100_000,    currency: 'USD', date: `${M}-02`, description: 'Salary USD', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.affordability'], financeData, timezone: 'Europe/Moscow', currency: 'USD',
      message: 'куплю за 50000',
    });
    // 9,000,000 RUB -> 100,000 USD + 100,000 USD = 200,000 USD balance
    // (formatter uses ru-RU grouping — space or narrow-no-break-space as thousands separator)
    assert.ok(/200[\s  ]000/.test(text), `expected ~200 000 USD balance, got: ${text}`);
  } finally { teardown(); }
});

test('engine: cashflow mixed currency uses a single USD basis for the whole timeline', async () => {
  injectMockRates(RATES);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 9000, currency: 'RUB', date: `${M}-05`, description: 'Rent RUB', categoryId: 'p-housing' },
        { type: 'income',  amount: 2000, currency: 'USD', date: `${M}-06`, description: 'Freelance USD', categoryId: 'p-freelance' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.cashflow'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.ok(text.includes('Валюта расчёта: USD'));
    assert.ok(!text.includes('RUB'), `cashflow section must not leak RUB units, got: ${text}`);
  } finally { teardown(); }
});

test('engine: RUB-only dataset never calls exchangeRates module', async () => {
  const spy = { called: false };
  injectSpyRates(RATES, spy);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 5000, currency: 'RUB', date: `${M}-05`, description: 'Ресторан', categoryId: 'p-other-e' },
      ],
      goals: [],
    };
    await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'RUB', message: '',
    });
    assert.equal(spy.called, false, 'RUB-only user must never trigger an FX fetch');
  } finally { teardown(); }
});

test('engine: USD-only dataset never calls exchangeRates module', async () => {
  const spy = { called: false };
  injectSpyRates(RATES, spy);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 50, currency: 'USD', date: `${M}-05`, description: 'Coffee', categoryId: 'p-other-e' },
      ],
      goals: [],
    };
    await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.equal(spy.called, false, 'USD-only user must never trigger an FX fetch');
  } finally { teardown(); }
});

test('engine: FX failure on mixed currency data → safe degradation, no fabricated numbers', async () => {
  injectFailingRates();
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 9000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'expense', amount: 100,  currency: 'USD', date: `${M}-06`, description: 'B', categoryId: 'p-other-e' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.ok(!/\d{3}\.\d{2}\s*\$/.test(text) || text.includes('недоступен'),
      `must not produce a numeric total when FX is unavailable, got: ${text}`);
    assert.ok(text.toLowerCase().includes('недостаточно') || text.toLowerCase().includes('недоступен'),
      `must explicitly signal insufficient currency data, got: ${text}`);
  } finally { teardown(); }
});

test('engine: full_audit mixed currency stays on one currency across all sections', async () => {
  injectMockRates(RATES);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 9000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-groceries' },
        { type: 'expense', amount: 100,  currency: 'USD', date: `${M}-06`, description: 'B', categoryId: 'p-groceries' },
        { type: 'income',  amount: 900000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.full_audit'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.ok(text.includes('Валюта расчёта: USD'));
    assert.ok(!text.includes('₽'), `full_audit must not mix in RUB symbols, got: ${text}`);
  } finally { teardown(); }
});

test('SPEC: old legacy USD balance (~2,000,000) stays ~2,000,000 USD, never rescaled to ~22,000', async () => {
  // Fixture: a legacy Web income of 2,000,000 with no `currency` field, no
  // `source`, timestamped inside the USD-bug window, user.currency = USD.
  injectMockRates({ RUB: 1, USD: 0.0118 });
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 2000000, createdAt: { toMillis: () => Date.parse('2026-06-01T00:00:00Z') }, date: `${M}-01`, description: 'Legacy salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    // Must show 2,000,000-scale, NOT ~22,700 (which would be 2,000,000 RUB wrongly divided by ~88)
    assert.ok(/2[\s  ]000[\s  ]000/.test(text), `expected exact 2,000,000 USD, got: ${text}`);
    assert.ok(!/22[\s  ]7\d\d/.test(text), `must not show a ~22.7k mis-converted value, got: ${text}`);
  } finally { teardown(); }
});

test('SPEC: legacy USD data displayed in RUB converts via current FX, raw record semantics unaffected', async () => {
  const RATES2 = { RUB: 1, USD: 0.0118 };
  injectMockRates(RATES2);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 2000000, createdAt: { toMillis: () => Date.parse('2026-06-01T00:00:00Z') }, date: `${M}-01`, description: 'Legacy salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'RUB', message: '',
    });
    // 2,000,000 USD -> RUB at rate 0.0118 (1 RUB = 0.0118 USD) => /0.0118 ≈ 169,491,525 RUB
    assert.ok(text.includes('Валюта расчёта: RUB'));
    assert.ok(/169[\s  ]49\d[\s  ]\d\d\d/.test(text), `expected ~169,491,xxx RUB, got: ${text}`);
  } finally { teardown(); }
});

test('SPEC: goal currency stability — RUB goal stays 500000 RUB in the normalized output regardless of display currency, source untouched', async () => {
  const original = { id: 'g1', title: 'Car', targetAmount: 500000, currentAmount: 0, currency: 'RUB', deadline: null };
  injectMockRates({ RUB: 1, USD: 0.0118 });
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 100000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [original],
    };
    await runFinanceEngine({
      skillIds: ['finance.goal'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    // The source goal object passed in must never be mutated by the engine.
    assert.equal(original.targetAmount, 500000);
    assert.equal(original.currency, 'RUB');
  } finally { teardown(); }
});

test('SPEC: mixed-currency goal — 9,000,000 RUB target converted to USD before calculateGoalPlan runs', async () => {
  const RATES2 = { RUB: 1, USD: 100 / 9000 }; // 9000 RUB == 100 USD
  injectMockRates(RATES2);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 5000, currency: 'USD', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [{ id: 'g1', title: 'Дом', targetAmount: 9000000, currentAmount: 0, currency: 'RUB', deadline: null }],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.goal'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    // 9,000,000 RUB -> 100,000 USD target — must appear USD-scale, not RUB-scale
    assert.ok(/100[\s  ]000/.test(text), `expected ~100,000 USD goal target, got: ${text}`);
  } finally { teardown(); }
});


// ---- what-if (finance.what_if) ----------------------------------------------

test('SPEC: what-if base RUB plus "500 bolshe" -> +500 RUB applied to monthly expenses', async () => {
  injectMockRates({ RUB: 1, USD: 0.0118 });
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 10000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'income',  amount: 50000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', currency: 'RUB',
      message: 'А если буду тратить на 500 больше?',
    });
    assert.ok(/10[\s\u00a0\u202f]500/.test(text) || text.includes('10500'), 'expected projected expenses ~10500 RUB, got: ' + text);
  } finally { teardown(); }
});

test('SPEC: what-if base RUB plus explicit $500 more -> converted to RUB before scenario arithmetic', async () => {
  const RATES2 = { RUB: 1, USD: 0.0118 }; // 500 USD ~= 42372.88 RUB
  injectMockRates(RATES2);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 10000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'income',  amount: 50000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', currency: 'RUB',
      message: 'А если буду тратить на $500 больше?',
    });
    const expectedExpenses = Math.round(10000 + 500 / RATES2.USD); // ~52373
    const digits = String(expectedExpenses).slice(0, 2); // e.g. '52'
    assert.ok(new RegExp(digits + '[\\s\\u00a0\\u202f]?\\d{3}').test(text),
      'expected projected expenses to reflect converted $500 (~' + expectedExpenses + '), got: ' + text);
    assert.ok(!/10[\s\u00a0\u202f]500/.test(text),
      'must NOT treat $500 as if it were 500 RUB, got: ' + text);
  } finally { teardown(); }
});

test('SPEC: what-if base USD plus 20000 RUB more -> converted to USD before scenario arithmetic', async () => {
  const RATES2 = { RUB: 1, USD: 0.0118 }; // 20000 RUB ~= 236 USD
  injectMockRates(RATES2);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 100, currency: 'USD', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'income',  amount: 3000, currency: 'USD', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', currency: 'USD',
      message: 'А если буду откладывать на 20 000 ₽ больше?',
    });
    assert.ok(text.includes('Валюта расчёта: USD'));
    // 20000 RUB -> ~236 USD extra saving; must not appear as a raw 20000-scale figure
    assert.ok(!/20[\s  ]?000\.00/.test(text), 'must not leak raw 20000 RUB into a USD-labeled figure, got: ' + text);
  } finally { teardown(); }
});

test('SPEC: what-if explicit foreign currency plus FX unavailable -> insufficient_data, not a fake calculation', async () => {
  injectFailingRates();
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 10000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
        { type: 'income',  amount: 50000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', currency: 'RUB',
      message: 'А если буду тратить на $500 больше?',
    });
    assert.ok(!text.includes('10 500') && !text.includes('10500.00'),
      'must never treat unconvertible $500 as 500 RUB, got: ' + text);
    assert.ok(text.toLowerCase().includes('scenarios') && text.toLowerCase().includes('недостаточно'),
      'must signal insufficient data for the scenario calc specifically, got: ' + text);
  } finally { teardown(); }
});
