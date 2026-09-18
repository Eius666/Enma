'use strict';

const { calculateMetrics }       = require('./metrics');
const { calculateAffordability } = require('./affordability');
const { calculateGoalPlan }      = require('./goals');
const { calculateCashflow }      = require('./cashflow');
const { calculateLeakSignals }   = require('./leaks');
const { calculateMonthReview }   = require('./monthReview');
const { calculateStressTest }    = require('./stressTest');
const { calculateDebtStrategy }  = require('./debt');
const { calculateScenario }      = require('./scenarios');
const { round, ROUNDING }        = require('./constants');
const { normalizeTransactionsCurrency, needsFx, normalizeGoalsCurrency, goalsNeedFx } = require('./normalizeCurrency');
const { getExchangeRates }       = require('../exchangeRates');
const { HOME_BUDGET_CURRENCY }   = require('../config');
const { extractMoneyAmount }     = require('./extractMoneyAmount');
const { parseScenarioModification } = require('./scenarioModification');
const { convertCurrency }        = require('../convertCurrency');

// ── Skill → calculations mapping ─────────────────────────────────────────────
// Each skill declares which calculators to run before the LLM sees the prompt.

const SKILL_CALCULATIONS = {
  'finance.full_audit':         ['metrics', 'monthReview', 'cashflow', 'leaks', 'goals'],
  'finance.affordability':      ['affordability', 'metrics'],
  'finance.leaks':              ['leaks', 'metrics'],
  'finance.goal':               ['goals', 'metrics'],
  'finance.budget':             ['metrics', 'monthReview', 'leaks'],
  'finance.month_review':       ['monthReview', 'metrics', 'leaks'],
  'finance.stress_test':        ['stressTest', 'metrics'],
  'finance.cashflow':           ['cashflow', 'metrics'],
  'finance.salary_distribution':['metrics', 'cashflow'],
  'finance.what_if':            ['scenarios', 'metrics'],
  'finance.debt':               ['debt', 'metrics'],
  'finance.payment_calendar':   ['cashflow'],
};

// ── Runner ────────────────────────────────────────────────────────────────────

function runCalc(name, { transactions, goals, timezone, message, currency, inputCurrency, rates, scenarioModification }) {
  switch (name) {
    case 'metrics':      return calculateMetrics({ transactions, timezone });
    case 'monthReview':  return calculateMonthReview({ transactions, timezone });
    case 'cashflow':     return calculateCashflow({ transactions, timezone });
    case 'leaks':        return calculateLeakSignals({ transactions, timezone });
    case 'stressTest':   return calculateStressTest({ transactions, timezone });
    case 'scenarios': {
      if (!scenarioModification) {
        // No modification detected in this message — plain baseline projection.
        return calculateScenario({ transactions, timezone });
      }

      // Conversion happens BEFORE scenario arithmetic, once, here — never
      // treat "500 USD" as "500 RUB" just because no rate was available.
      // An implicit (no currency named) modification resolves against the
      // user's current input currency (user.currency), like a bare "5000".
      const modCurrency = scenarioModification.currency ?? inputCurrency;
      let delta;
      if (modCurrency === currency) {
        delta = scenarioModification.delta;
      } else if (rates) {
        delta = convertCurrency(scenarioModification.delta, modCurrency, currency, rates);
      } else {
        return {
          status:  'insufficient_data',
          missing: ['fx_rate'],
          note:    `modification named in ${modCurrency} but FX to ${currency} is unavailable`,
        };
      }

      const modifications = {};
      if (scenarioModification.type === 'income_change')   modifications.incomeChange = delta;
      if (scenarioModification.type === 'expense_change')  modifications.expenseChange = delta;
      if (scenarioModification.type === 'savings_change')  modifications.monthlySavingExtra = delta;

      return calculateScenario({ transactions, modifications, timezone });
    }
    case 'goals': {
      if (!Array.isArray(goals) || goals.length === 0) {
        return { status: 'insufficient_data', missing: ['goals'] };
      }
      return calculateGoalPlan({ goals, transactions, timezone });
    }
    case 'affordability': {
      // "Могу купить за 5000 USD?" must be parsed as $5000. When no currency
      // is named ("Могу купить за 5000?"), the amount is assumed to be in
      // the user's current input currency (user.currency), like a bare "5000".
      const parsed = extractMoneyAmount(message, inputCurrency);
      let purchaseAmount = null;
      if (parsed) {
        if (parsed.currency === currency) {
          purchaseAmount = parsed.amount;
        } else if (rates) {
          purchaseAmount = convertCurrency(parsed.amount, parsed.currency, currency, rates);
        }
        // else: needs FX to reach the reporting currency but it's
        // unavailable — leave purchaseAmount null rather than silently
        // treat it as already being in `currency`.
      }
      return calculateAffordability({ purchaseAmount, transactions, goals, timezone });
    }
    case 'debt':
      return { status: 'insufficient_data', missing: ['debts'], note: 'debt model not yet in ENMA' };
    default:
      return null;
  }
}

// ── Number formatter ─────────────────────────────────────────────────────────

function fmt(value, currency) {
  if (value === null || value === undefined) return '—';
  const sym = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥' }[currency] || currency || '₽';
  const n = Number(value);
  if (isNaN(n)) return String(value);
  const abs = Math.abs(n);
  const formatted = abs >= 1000
    ? Math.round(n).toLocaleString('ru-RU')
    : n.toFixed(2);
  return `${formatted} ${sym}`;
}

function fmtPct(v) {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toFixed(1)}%`;
}

// ── Result serializer → prompt section ───────────────────────────────────────

function serializeResults(calcs, currency, skillIds) {
  const c = currency || 'RUB';
  const lines = ['[CALCULATED FINANCIAL METRICS]',
    `Валюта расчёта: ${c}`,
    'Рассчитано детерминистически backend-движком. Используй эти числа как источник истины — не пересчитывай самостоятельно.',
    ''];

  for (const [name, result] of Object.entries(calcs)) {
    if (!result || result.status === 'insufficient_data') {
      if (result?.missing) {
        lines.push(`[${name.toUpperCase()}] Недостаточно данных: ${result.missing.join(', ')}`);
      }
      continue;
    }

    if (name === 'metrics') {
      const m = result;
      lines.push(`[МЕТРИКИ — ${m.period}]`);
      lines.push(`  Баланс (все время):   ${fmt(m.currentBalance?.value, c)}  [факт]`);
      lines.push(`  Доходы (месяц):       ${fmt(m.currentMonth?.income, c)}`);
      lines.push(`  Расходы (месяц):      ${fmt(m.currentMonth?.expenses, c)}`);
      lines.push(`  Разница (месяц):      ${fmt(m.currentMonth?.net, c)}`);
      if (m.savingsRate?.value != null) {
        lines.push(`  Норма сбережений:     ${fmtPct(m.savingsRate.value)}`);
      }
      lines.push(`  Среднемесячн. доход:  ${fmt(m.averages?.monthlyIncome, c)}`);
      lines.push(`  Среднемесячн. расход: ${fmt(m.averages?.monthlyExpenses, c)}`);
      if (m.runwayMonths?.value != null) {
        lines.push(`  Финансовая подушка:   ${m.runwayMonths.value} мес.  [${m.emergencyFund?.status}]`);
      }
      if (m.topCategories?.length) {
        lines.push('  Топ категорий расходов:');
        for (const cat of m.topCategories) {
          lines.push(`    ${cat.name}: ${fmt(cat.amount, c)}`);
        }
      }
      lines.push('');
    }

    if (name === 'affordability') {
      const a = result;
      lines.push('[ПОКУПАТЕЛЬНАЯ СПОСОБНОСТЬ]');
      lines.push(`  Текущий баланс:        ${fmt(a.currentBalance?.value, c)}  [факт]`);
      lines.push(`  Среднемесячн. расход:  ${fmt(a.avgMonthlyExpenses?.value, c)}  [оценка]`);
      lines.push(`  Целевой буфер безопасности: ${fmt(a.bufferTarget?.value, c)}`);
      if (a.goalMonthlyCommitment?.value > 0) {
        lines.push(`  Обязательства по целям/мес: ${fmt(a.goalMonthlyCommitment?.value, c)}`);
      }
      if (a.purchaseAmount?.value) {
        lines.push(`  Запрошенная покупка:   ${fmt(a.purchaseAmount.value, c)}`);
        const sNow  = a.scenarios?.now;
        const sNext = a.scenarios?.afterNextIncome;
        if (sNow) {
          lines.push('  Сценарий СЕЙЧАС:');
          lines.push(`    После покупки:        ${fmt(sNow.cashAfterPurchase, c)}`);
          lines.push(`    После покупки+расходы: ${fmt(sNow.cashAfterMonthlyExpenses, c)}`);
          lines.push(`    Дефицит буфера:       ${fmt(sNow.bufferShortfall, c)}`);
        }
        if (sNext) {
          lines.push('  Сценарий ПОСЛЕ СЛЕДУЮЩЕГО ДОХОДА [оценка]:');
          lines.push(`    Баланс до покупки:    ${fmt(sNext.cashBefore, c)}`);
          lines.push(`    После покупки:        ${fmt(sNext.cashAfterPurchase, c)}`);
          lines.push(`    Дефицит буфера:       ${fmt(sNext.bufferShortfall, c)}`);
        }
      } else {
        lines.push('  Сумма покупки не указана — расчёт сценариев недоступен.');
      }
      lines.push('');
    }

    if (name === 'goals') {
      lines.push('[ЦЕЛИ НАКОПЛЕНИЯ]');
      for (const g of (result.goals || [])) {
        lines.push(`  ${g.title}: ${fmt(g.current, c)} / ${fmt(g.target, c)} (${fmtPct(g.pctDone)})`);
        if (g.status === 'with_deadline') {
          lines.push(`    Осталось:             ${fmt(g.remaining, c)}`);
          lines.push(`    До дедлайна:          ${g.monthsLeft} мес.`);
          lines.push(`    Необходимо/мес:       ${fmt(g.requiredMonthly?.value, c)}  [расчёт]`);
          if (g.feasible !== undefined) {
            lines.push(`    Выполнимо при текущем темпе: ${g.feasible ? 'ДА' : 'НЕТ'}`);
            if (!g.feasible) lines.push(`    Нехватка/мес:         ${fmt(g.shortfall?.value, c)}`);
          }
        } else if (g.status === 'no_deadline') {
          lines.push(`    До цели (при текущем темпе): ${g.estimatedMonthsToGoal?.value} мес. (≈ ${g.estimatedCompletion?.value})`);
        }
      }
      lines.push('');
    }

    if (name === 'cashflow') {
      const cf = result;
      lines.push(`[CASHFLOW — ${cf.period}]`);
      lines.push(`  Текущий баланс:       ${fmt(cf.openingBalance?.value, c)}  [факт]`);
      lines.push(`  Зафиксировано доходов:  ${fmt(cf.currentMonth?.recordedIncome, c)}`);
      lines.push(`  Зафиксировано расходов: ${fmt(cf.currentMonth?.recordedExpenses, c)}`);
      lines.push(`  Прогноз до конца месяца:`);
      lines.push(`    Ожидаемые доходы:   ${fmt(cf.projections?.remainingIncome?.value, c)}  [оценка]`);
      lines.push(`    Ожидаемые расходы:  ${fmt(cf.projections?.remainingExpenses?.value, c)}  [оценка]`);
      lines.push(`    Баланс к концу мес: ${fmt(cf.projections?.closingBalance?.value, c)}  [прогноз]`);
      if (cf.cashGap) {
        lines.push('  ⚠ КАССОВЫЙ РАЗРЫВ ОБНАРУЖЕН');
        if (cf.minimumBalance?.value < 0) {
          lines.push(`    Минимальный баланс: ${fmt(cf.minimumBalance.value, c)}  [факт]`);
        }
      }
      lines.push('');
    }

    if (name === 'leaks') {
      const l = result;
      lines.push('[СИГНАЛЫ УТЕЧЕК]');
      if (!l.signals || l.signals.length === 0) {
        lines.push('  Явных паттернов утечек не обнаружено.');
      } else {
        for (const sig of l.signals) {
          if (sig.type === 'recurring') {
            lines.push(`  [РЕГУЛЯРНЫЙ] ${sig.description}: ~${fmt(sig.avgAmount, c)}/мес (~${fmt(sig.totalPerYear, c)}/год) conf=${fmtPct(sig.confidence*100)}`);
          } else if (sig.type === 'category_spike') {
            lines.push(`  [РОСТ КАТЕГОРИИ] ${sig.category}: ${fmt(sig.prevAmt, c)} → ${fmt(sig.currentAmt, c)} (+${fmtPct(sig.increasePct)})`);
          } else if (sig.type === 'duplicate') {
            lines.push(`  [ДУБЛИКАТ] ${sig.description}: ${fmt(sig.amount, c)} [${sig.dates.join(' / ')}]`);
          } else if (sig.type === 'fee') {
            lines.push(`  [КОМИССИЯ] ${sig.description}: ${fmt(sig.amount, c)}`);
          }
        }
      }
      lines.push('');
    }

    if (name === 'monthReview') {
      const r = result;
      lines.push(`[СРАВНЕНИЕ МЕСЯЦЕВ: ${r.previousPeriod} → ${r.currentPeriod}]`);
      lines.push(`  Доходы:   ${fmt(r.previous?.income, c)} → ${fmt(r.current?.income, c)}` +
        (r.changes?.income !== null ? ` (${r.changes.income >= 0 ? '+' : ''}${fmtPct(r.changes.income)})` : ''));
      lines.push(`  Расходы:  ${fmt(r.previous?.expenses, c)} → ${fmt(r.current?.expenses, c)}` +
        (r.changes?.expenses !== null ? ` (${r.changes.expenses >= 0 ? '+' : ''}${fmtPct(r.changes.expenses)})` : ''));
      lines.push(`  Итог:     ${fmt(r.previous?.net, c)} → ${fmt(r.current?.net, c)}`);
      if (r.largestTransactions?.length) {
        lines.push('  Крупнейшие расходы месяца:');
        for (const tx of r.largestTransactions) {
          lines.push(`    ${tx.description}: ${fmt(tx.amount, c)}  (${tx.date})`);
        }
      }
      if (r.unusualTransactions?.length) {
        lines.push('  Необычные транзакции:');
        for (const tx of r.unusualTransactions) {
          lines.push(`    ${tx.description}: ${fmt(tx.amount, c)} (среднее кат: ${fmt(tx.categoryAvg, c)})`);
        }
      }
      lines.push('');
    }

    if (name === 'stressTest') {
      const st = result;
      lines.push('[СТРЕСС-ТЕСТ]');
      lines.push(`  Текущий баланс: ${fmt(st.baseline?.currentBalance?.value, c)}`);
      if (st.scenarios?.incomeDrop) {
        const s = st.scenarios.incomeDrop;
        lines.push(`  ${s.label}: доход → ${fmt(s.reducedIncome?.value, c)}/мес, итог/мес: ${fmt(s.monthlyNet?.value, c)}`);
        if (s.runwayMonths?.value != null) lines.push(`    Подушка на: ${s.runwayMonths.value} мес.`);
      }
      if (st.scenarios?.noIncome) {
        const s = st.scenarios.noIncome;
        lines.push(`  ${s.label}: нужно ${fmt(s.requiredCash?.value, c)}, есть ${fmt(s.availableCash?.value, c)}`);
        if (s.shortfall?.value > 0) lines.push(`    Дефицит: ${fmt(s.shortfall.value, c)}`);
      }
      if (st.scenarios?.emergencyExpense) {
        const s = st.scenarios.emergencyExpense;
        lines.push(`  ${s.label}: ${fmt(s.emergencyAmount?.value, c)} → баланс ${fmt(s.balanceAfter?.value, c)}`);
      }
      lines.push('');
    }

    if (name === 'scenarios') {
      const s = result;
      lines.push('[ЧТО ЕСЛИ — БАЗОВЫЕ ДАННЫЕ]');
      lines.push(`  Текущий баланс:       ${fmt(s.baseline?.currentBalance?.value, c)}`);
      lines.push(`  Доход/мес (средний):  ${fmt(s.baseline?.monthlyIncome?.value, c)}`);
      lines.push(`  Расход/мес (средний): ${fmt(s.baseline?.monthlyExpenses?.value, c)}`);
      lines.push(`  Чистый/мес:           ${fmt(s.baseline?.monthlyNet?.value, c)}`);
      if (s.projected) {
        lines.push('  Прогноз с изменениями:');
        lines.push(`    Доход/мес:    ${fmt(s.projected.monthlyIncome?.value, c)}`);
        lines.push(`    Расход/мес:   ${fmt(s.projected.monthlyExpenses?.value, c)}`);
        lines.push(`    Чистый/мес:   ${fmt(s.projected.monthlyNet?.value, c)}`);
        lines.push(`    Баланс 3 мес: ${fmt(s.projected.balance3Months?.value, c)}`);
        lines.push(`    Баланс 6 мес: ${fmt(s.projected.balance6Months?.value, c)}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Main entry point ──────────────────────────────────────────────────────────
//
// Called from handleChat when active skills require financial calculations.
// Returns a formatted string to append to the system prompt.
//
// financeData = { transactions: [], goals: [] }

async function runFinanceEngine({ skillIds, financeData, timezone, currency, inputCurrency, message, previousScenarioModification }) {
  const { transactions: rawTransactions = [], goals: rawGoals = [] } = financeData || {};

  if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
    return '[CALCULATED FINANCIAL METRICS]\nДанные транзакций недоступны для расчёта.\n';
  }

  // Budget/analytics currency is FIXED (RUB) — the `currency` argument is
  // accepted for call-site compatibility but never overrides it.
  const baseCurrency = HOME_BUDGET_CURRENCY;
  // user.currency = the currency the user currently ENTERS things in: what a
  // bare amount in a purchase question / what-if means when no currency is
  // named. Falls back to RUB, never to anything derived from reporting.
  const inputDefaultCurrency = inputCurrency || HOME_BUDGET_CURRENCY;

  // Collect the union of required calculation names for active skills
  const calcNames = new Set();
  for (const id of (skillIds || [])) {
    for (const name of (SKILL_CALCULATIONS[id] || [])) {
      calcNames.add(name);
    }
  }

  // A purchase amount ("за 5000 USD" or implicit "за 5000") needs FX to
  // convert into baseCurrency whenever its resolved currency differs —
  // check for it before deciding whether to fetch rates.
  let purchaseNeedsFx = false;
  if (calcNames.has('affordability')) {
    const parsed = extractMoneyAmount(message, inputDefaultCurrency);
    purchaseNeedsFx = !!(parsed && parsed.currency !== baseCurrency);
  }

  // What-if modification ("буду тратить на $500 больше") — parsed here, once,
  // from the current message plus the previous turn's modification (for
  // follow-ups like "А если на $300?" that only restate the amount).
  let scenarioModification = null;
  if (calcNames.has('scenarios')) {
    scenarioModification = parseScenarioModification(message, previousScenarioModification || null);
  }
  const scenarioNeedsFx = !!(
    scenarioModification && (scenarioModification.currency ?? inputDefaultCurrency) !== baseCurrency
  );

  // Normalize ONCE, before any calculator runs: convert every transaction (and
  // every goal) from its own currency into baseCurrency. Calculators below
  // then just read `amount`/`targetAmount`/`currentAmount` — they never need
  // to know about currency at all. FX is only fetched if something actually
  // differs from baseCurrency, so a RUB-only or USD-only user never depends
  // on the FX API. Transaction currency is resolved via
  // resolveTransactionCurrency — a record whose real historical currency
  // cannot be proven makes the whole batch unsafe to compute exactly.
  const rates = (needsFx(rawTransactions, baseCurrency) || goalsNeedFx(rawGoals, baseCurrency) || purchaseNeedsFx || scenarioNeedsFx)
    ? await getExchangeRates()
    : null;
  const { transactions, ok: txCurrencyOk } = normalizeTransactionsCurrency(rawTransactions, baseCurrency, rates);
  const { goals, ok: goalsCurrencyOk }     = normalizeGoalsCurrency(rawGoals, baseCurrency, rates);

  if (!txCurrencyOk || !goalsCurrencyOk) {
    console.warn(`[FINANCE_ENGINE] insufficient_currency_data baseCurrency=${baseCurrency}`);
    return '[CALCULATED FINANCIAL METRICS]\n' +
      'Недостаточно данных о курсе валют: часть операций в другой валюте, а курс обмена сейчас недоступен. ' +
      'Точный расчёт невозможен — не используй эти данные для числовых выводов.\n';
  }

  if (calcNames.size === 0) return null; // no calculations needed

  const ctx   = { transactions, goals, timezone, currency: baseCurrency, inputCurrency: inputDefaultCurrency, message, rates, scenarioModification };
  const results = {};
  const t0    = Date.now();

  for (const name of calcNames) {
    try {
      results[name] = runCalc(name, ctx);
    } catch (err) {
      console.error(`[FINANCE_ENGINE] calc=${name} error:`, err.message);
      results[name] = { status: 'error', error: err.message };
    }
  }

  const durMs = Date.now() - t0;
  console.log(`[FINANCE_ENGINE] skills=${[...skillIds||[]].join(',')} calcs=${[...calcNames].join(',')} dur=${durMs}ms`);

  return serializeResults(results, baseCurrency, skillIds);
}

module.exports = {
  runFinanceEngine,
  calculateMetrics,
  calculateAffordability,
  calculateGoalPlan,
  calculateCashflow,
  calculateLeakSignals,
  calculateMonthReview,
  calculateStressTest,
  calculateDebtStrategy,
  calculateScenario,
  SKILL_CALCULATIONS,
};
