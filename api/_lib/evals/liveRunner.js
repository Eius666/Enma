#!/usr/bin/env node
'use strict';

// ── Live LLM Evaluation Runner (optional) ─────────────────────────────────────
//
// Requires: OPENROUTER_API_KEY in environment
//
// Usage:
//   npm run eval:live
//   npm run eval:live -- --model google/gemma-3-27b-it --max-scenarios 5
//
// This runner:
//   1. Builds a minimal system prompt from skill context
//   2. Calls the real LLM (via OpenRouter)
//   3. Evaluates the response against a binary rubric
//   4. Reports pass/fail per rubric item (not a subjective 0-10 score)
//
// COST CONTROL:
//   --max-scenarios N  (default: 5) — hard cap on total LLM calls
//   --max-tokens N     (default: 10000) — hard cap on total token budget
//   --model NAME       (default: env OPENROUTER_MODEL or openai/gpt-4o-mini)

'use strict';

const https = require('https');

const { VERSIONS }      = require('./VERSIONS');
const {
  makeAffordabilityTransactions,
  makeGoalFixture,
} = require('./fixtures');
const { composeSystemPrompt, routeSkill } = (() => {
  try { return require('../skillRouter'); } catch { return {}; }
})();

// ── Config ─────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL        = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
const DEFAULT_MAX_SCENARIOS = 5;
const DEFAULT_MAX_TOKENS    = 10000;

// ── Live eval scenarios ────────────────────────────────────────────────────────
// Each scenario has a rubric: array of { id, question, expect (true/false) }
// The evaluator checks each rubric item against the LLM response.

const LIVE_SCENARIOS = [
  {
    id:          'live.affordability.basic',
    description: 'Affordability with pre-filled balance — AI must use it, not ask for it',
    input:       'Могу ли я купить ноутбук за 150 000 ₽?',
    skillId:     'finance.affordability',
    systemContext: buildAffordabilityContext(),
    rubric: [
      {
        id:       'uses_balance',
        question: 'Does the response use or reference the pre-provided balance (200,000)?',
        check:    (r) => /200\s*000|200к|200 тыс/i.test(r),
        expect:   true,
      },
      {
        id:       'no_ask_balance',
        question: 'Does the response ask the user for their balance?',
        check:    (r) => /какой.*баланс|сколько.*счёт|каков.*баланс/i.test(r),
        expect:   false,
      },
      {
        id:       'contains_numbers',
        question: 'Does the response contain numeric amounts?',
        check:    (r) => /\d{4,}/.test(r),
        expect:   true,
      },
      {
        id:       'ru_language',
        question: 'Is the response in Russian?',
        check:    (r) => /[а-яё]/i.test(r),
        expect:   true,
      },
      {
        id:       'no_hallucinated_claim',
        question: 'Does the response claim AI cannot see financial data?',
        check:    (r) => /не вижу|не знаю ваш баланс|нет данных о балансе/i.test(r),
        expect:   false,
      },
    ],
  },

  {
    id:          'live.general.no_personal',
    description: 'General educational question — AI should not ask for personal data',
    input:       'Что такое сложный процент?',
    skillId:     null,
    systemContext: 'Пользователь задаёт общий вопрос. Личных финансовых данных не предоставлено.',
    rubric: [
      {
        id:       'explains_concept',
        question: 'Does the response explain compound interest?',
        check:    (r) => /процент|накапл|капитализ|начисл/i.test(r),
        expect:   true,
      },
      {
        id:       'no_ask_balance',
        question: 'Does the response ask for personal balance or income?',
        check:    (r) => /ваш баланс|ваш доход|сколько у вас/i.test(r),
        expect:   false,
      },
    ],
  },

  {
    id:          'live.empty_user.no_hallucination',
    description: 'SPEC §53: new user with no data — AI must not invent metrics',
    input:       'Разбери мои финансы.',
    skillId:     'finance.full_audit',
    systemContext: '[CONTEXT]\nТранзакции: нет данных.\nЦели: нет данных.',
    rubric: [
      {
        id:       'no_invented_balance',
        question: 'Does response invent a specific balance without it being provided?',
        check:    (r) => /баланс[^:]*\d{4,}|баланс составляет \d+/i.test(r),
        expect:   false,
      },
      {
        id:       'acknowledges_missing_data',
        question: 'Does response acknowledge that financial data is missing?',
        check:    (r) => /нет данных|не хватает|пока нет|отсутству|нет информации/i.test(r),
        expect:   true,
      },
    ],
  },

  {
    id:          'live.goal.calculation_used',
    description: 'SPEC §10: LLM must use pre-calculated requiredMonthly, not re-derive it',
    input:       'Хочу накопить 500 000 к маю следующего года. Сколько откладывать?',
    skillId:     'finance.goal',
    systemContext: buildGoalContext(),
    rubric: [
      {
        id:       'contains_monthly_amount',
        question: 'Does response mention a specific monthly savings amount?',
        check:    (r) => /\d{2,}\s*000|тысяч в месяц|ежемесячно/i.test(r),
        expect:   true,
      },
      {
        id:       'no_ask_savings_capacity',
        question: 'Does response ask "how much can you save per month?"',
        check:    (r) => /сколько.*откладывать|сколько.*в месяц|ваши сбережения/i.test(r),
        expect:   false,
      },
    ],
  },

  {
    id:          'live.known_data.not_asked',
    description: 'SPEC §86: context has balance=100k — AI must not ask "what is your balance?"',
    input:       'Какой у меня баланс?',
    skillId:     null,
    systemContext: '[ФИНАНСОВЫЙ КОНТЕКСТ]\nТекущий баланс: 100 000 ₽',
    rubric: [
      {
        id:       'states_balance',
        question: 'Does response state that balance is 100,000?',
        check:    (r) => /100\s*000|100к/i.test(r),
        expect:   true,
      },
      {
        id:       'no_ask_for_balance',
        question: 'Does response ask the user what their balance is?',
        check:    (r) => /какой.*баланс\?|укажите.*баланс/i.test(r),
        expect:   false,
      },
    ],
  },
];

// ── Context builders ───────────────────────────────────────────────────────────

function buildAffordabilityContext() {
  const txs = makeAffordabilityTransactions();
  return `[CALCULATED FINANCIAL METRICS]
currentBalance: 200 000 ₽
avgMonthlyExpenses: 40 000 ₽
avgMonthlyIncome: 240 000 ₽

Сценарий покупки на 150 000 ₽ прямо сейчас:
  - Остаток после покупки: 50 000 ₽
  - Остаток после покупки и обязательных расходов: 10 000 ₽`;
}

function buildGoalContext() {
  return `[CALCULATED FINANCIAL METRICS]
Цель "Накопить 500 000": осталось 400 000 ₽
Примерно через 8 месяцев
Требуемые ежемесячные взносы: 50 000 ₽
Текущая ежемесячная экономия: 120 000 ₽`;
}

// ── LLM caller ────────────────────────────────────────────────────────────────

function callOpenRouter(model, systemPrompt, userMessage, maxTokens = 400) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      temperature: 0.1, // low temperature for determinism
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path:     '/api/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer':  'https://enma-app.com',
        'X-Title':       'ENMA Eval',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'LLM API error'));
          const text = parsed.choices?.[0]?.message?.content ?? '';
          const usage = parsed.usage ?? {};
          resolve({ text, usage });
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Rubric evaluator ──────────────────────────────────────────────────────────

function evaluateRubric(response, rubric) {
  return rubric.map(item => {
    const actual = item.check(response);
    return {
      id:       item.id,
      question: item.question,
      expected: item.expect,
      actual,
      pass:     actual === item.expect,
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv  = process.argv.slice(2);
  const model = argv.find((_, i) => argv[i - 1] === '--model') ?? DEFAULT_MODEL;
  const maxSc = parseInt(argv.find((_, i) => argv[i - 1] === '--max-scenarios') ?? DEFAULT_MAX_SCENARIOS, 10);
  const maxTk = parseInt(argv.find((_, i) => argv[i - 1] === '--max-tokens') ?? DEFAULT_MAX_TOKENS, 10);

  if (!process.env.OPENROUTER_API_KEY) {
    console.error('[live] OPENROUTER_API_KEY not set — aborting');
    process.exit(1);
  }

  const scenarios = LIVE_SCENARIOS.slice(0, maxSc);
  const { CORE_PROMPT } = require('../skills/core');

  console.log('\n  ENMA Live LLM Eval');
  console.log(`  model: ${model}  maxScenarios: ${maxSc}  maxTotalTokens: ${maxTk}`);
  console.log(`  core=${VERSIONS.core}\n`);

  let totalTokens = 0;
  let passed = 0;
  let failed = 0;

  for (const sc of scenarios) {
    if (totalTokens >= maxTk) {
      console.log(`\n  Token budget (${maxTk}) exhausted — stopping.`);
      break;
    }

    process.stdout.write(`  Running ${sc.id}...\n`);
    const systemPrompt = `${CORE_PROMPT}\n\n${sc.systemContext}`;

    let response;
    let usage;
    try {
      const r = await callOpenRouter(model, systemPrompt, sc.input, 400);
      response = r.text;
      usage    = r.usage;
      totalTokens += usage.total_tokens ?? 0;
    } catch (e) {
      console.error(`    ✗ LLM call failed: ${e.message}`);
      failed++;
      continue;
    }

    const items = evaluateRubric(response, sc.rubric);
    const allPass = items.every(i => i.pass);
    if (allPass) passed++;
    else failed++;

    console.log(`    ${allPass ? '✓' : '✗'} ${sc.id} (${usage?.total_tokens ?? '?'}t)`);
    for (const item of items) {
      const icon = item.pass ? '  ✓' : '  ✗';
      console.log(`    ${icon} [${item.id}] ${item.question}`);
      if (!item.pass) {
        console.log(`         expected: ${item.expected}, actual: ${item.actual}`);
        console.log(`         response excerpt: "${response.slice(0, 120)}..."`);
      }
    }
    console.log();
  }

  console.log(`\n  Scenarios: ${scenarios.length}  Passed: ${passed}  Failed: ${failed}`);
  console.log(`  Total tokens used: ${totalTokens} / ${maxTk}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error('[live-runner]', e.message);
  process.exit(2);
});
