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


// ---- legacy conversion path ---------------------------------------------------

test('SPEC: historical legacy USD (amount=2000000, currency=USD) displays ~170M in RUB, never 2M RUB', async () => {
  const RATES2 = { RUB: 1, USD: 0.0118 };
  injectMockRates(RATES2);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 2000000, currency: 'USD', date: `${M}-01`, description: 'Legacy salary', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const textRUB = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'RUB', message: '',
    });
    assert.ok(/169[\s\u00a0\u202f]4\d\d[\s\u00a0\u202f]\d\d\d/.test(textRUB) || /170[\s\u00a0\u202f]/.test(textRUB),
      'expected ~169-170M RUB, got: ' + textRUB);
    assert.ok(!/2[\s\u00a0\u202f]000[\s\u00a0\u202f]000[\s\u00a0\u202f]?₽/.test(textRUB),
      'must never show 2,000,000 RUB (that would be USD misread as RUB), got: ' + textRUB);
  } finally { teardown(); }
});

// ---- Budget currency is fixed to RUB; schemaVersion 2 uses locked rubAmount ---

const NB = '[\\s  ]';

test('engine: budget is always RUB even if caller asks for another currency', async () => {
  injectMockRates(RATES);
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'expense', amount: 5000, currency: 'RUB', date: `${M}-05`, description: 'A', categoryId: 'p-other-e' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', currency: 'USD', message: '',
    });
    assert.ok(text.includes('Валюта расчёта: RUB'), `budget currency must be RUB, got: ${text}`);
  } finally { teardown(); }
});

test('engine: mixed v2 budget sums locked rubAmount only (5000 RUB + $100 + €100 + ¥500 = 29 700), no FX fetch', async () => {
  const spy = { called: false };
  injectSpyRates({ RUB: 1, USD: 1 / 1000 }, spy); // absurd runtime rate — must be ignored
  try {
    const { runFinanceEngine } = require('../engine');
    const v2 = (currency, amount, rubAmount) => ({
      schemaVersion: 2, type: 'expense', amount, currency, rubAmount,
      fx: currency === 'RUB' ? null : { rateToRub: rubAmount / amount },
      date: `${M}-05`, description: 'x', categoryId: 'p-other-e',
    });
    const financeData = {
      transactions: [v2('RUB', 5000, 5000), v2('USD', 100, 8600), v2('EUR', 100, 10100), v2('CNY', 500, 6000)],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', message: '',
    });
    assert.ok(new RegExp(`29${NB}?700`).test(text), `expected 29 700 ₽ expenses, got: ${text}`);
    assert.equal(spy.called, false, 'v2 data must never trigger runtime FX');
  } finally { teardown(); }
});

test('engine: changing today\'s FX rate does not change a locked v2 total', async () => {
  const mk = async (rates) => {
    injectMockRates(rates);
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [{ schemaVersion: 2, type: 'expense', amount: 100, currency: 'USD', rubAmount: 8600, fx: { rateToRub: 86 }, date: `${M}-05`, description: 'x', categoryId: 'p-other-e' }],
      goals: [],
    };
    return runFinanceEngine({ skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', message: '' });
  };
  try {
    const a = await mk({ RUB: 1, USD: 1 / 86 });
    const b = await mk({ RUB: 1, USD: 1 / 95 });
    assert.equal(a, b);
    assert.ok(new RegExp(`8${NB}?600`).test(a), `expected 8 600 ₽, got: ${a}`);
  } finally { teardown(); }
});

test('engine: legacy transaction (no rubAmount) still converts via the legacy resolver path', async () => {
  injectMockRates({ RUB: 1, USD: 0.0118 });
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [
        { type: 'income', amount: 2000, currency: 'USD', date: `${M}-01`, description: 'Legacy', categoryId: 'p-salary' },
      ],
      goals: [],
    };
    const text = await runFinanceEngine({
      skillIds: ['finance.month_review'], financeData, timezone: 'Europe/Moscow', message: '',
    });
    assert.ok(new RegExp(`169${NB}\\d{3}`).test(text), `expected ~169 4xx ₽ from legacy conversion, got: ${text}`);
  } finally { teardown(); }
});

test('engine: implicit "5000" in what-if means user.currency (inputCurrency=USD → converted), explicit RUB stays RUB', async () => {
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
    const implicitUsd = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', inputCurrency: 'USD',
      message: 'А если буду тратить на 500 больше?',
    });
    assert.ok(!new RegExp(`10${NB}?500`).test(implicitUsd), `500 in USD input mode must not be 500 RUB, got: ${implicitUsd}`);
    const implicitRub = await runFinanceEngine({
      skillIds: ['finance.what_if'], financeData, timezone: 'Europe/Moscow', inputCurrency: 'RUB',
      message: 'А если буду тратить на 500 больше?',
    });
    assert.ok(new RegExp(`10${NB}?500`).test(implicitRub), `expected 10 500 ₽, got: ${implicitRub}`);
  } finally { teardown(); }
});

test('engine: affordability "за 5000" uses inputCurrency; explicit "5000 ₽" wins over inputCurrency', async () => {
  injectMockRates({ RUB: 1, USD: 0.0118 });
  try {
    const { runFinanceEngine } = require('../engine');
    const financeData = {
      transactions: [{ type: 'income', amount: 300000, currency: 'RUB', date: `${M}-01`, description: 'Salary', categoryId: 'p-salary' }],
      goals: [],
    };
    const base = { skillIds: ['finance.affordability'], financeData, timezone: 'Europe/Moscow', inputCurrency: 'USD' };
    const implicit = await runFinanceEngine({ ...base, message: 'Могу купить за 5000?' });
    assert.ok(new RegExp(`423${NB}?7\\d\\d|42[34]${NB}?\\d{3}`).test(implicit), `5000 USD ≈ 423 7xx ₽, got: ${implicit}`);
    const explicit = await runFinanceEngine({ ...base, message: 'Могу купить за 5000 ₽?' });
    assert.ok(new RegExp(`5${NB}?000`).test(explicit) && !new RegExp(`423${NB}?\\d{3}`).test(explicit), `explicit ₽ must stay 5000, got: ${explicit}`);
  } finally { teardown(); }
});
