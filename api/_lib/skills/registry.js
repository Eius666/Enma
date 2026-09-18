'use strict';

const financeFullAudit        = require('./finance/fullAudit');
const financeAffordability    = require('./finance/affordability');
const financeLeaks            = require('./finance/leaks');
const financeGoal             = require('./finance/goal');
const financeBudget           = require('./finance/budget');
const financeDebt             = require('./finance/debt');
const financeCashflow         = require('./finance/cashflow');
const financeMonthReview      = require('./finance/monthReview');
const financeStressTest       = require('./finance/stressTest');
const financeWhatIf           = require('./finance/whatIf');
const financeSalaryDistribution = require('./finance/salaryDistribution');
const financePaymentCalendar  = require('./finance/paymentCalendar');
const tasksPlanDay            = require('./tasks/planDay');
const tasksPrioritize         = require('./tasks/prioritize');

// ── Framework-ready non-finance skills ──────────────────────────────────────

const FRAMEWORK_SKILLS = [
  {
    id:          'tasks.break_down',
    domain:      'tasks',
    description: 'Разбивает крупную задачу на подзадачи.',
    requiredContext: ['tasks'],
    allowedTools:   ['create_task', 'search_tasks'],
    canCombine: false, priority: 5,
    prompt: `Режим: ДЕКОМПОЗИЦИЯ ЗАДАЧИ\n\nРазбей задачу на конкретные подзадачи с чёткими критериями выполнения. Каждая подзадача должна быть выполнима за 1 сессию. Предложи порядок выполнения.`,
  },
  {
    id:          'tasks.review',
    domain:      'tasks',
    description: 'Еженедельный обзор задач: выполнено, просрочено, перенести.',
    requiredContext: ['tasks'],
    allowedTools:   ['search_tasks', 'complete_task', 'update_task'],
    canCombine: false, priority: 5,
    prompt: `Режим: ОБЗОР ЗАДАЧ\n\nПроведи обзор задач: выполненные, просроченные, предстоящие. Предложи, что перенести, что закрыть, что приоритизировать. Только данные из контекста.`,
  },
  {
    id:          'habits.create_plan',
    domain:      'habits',
    description: 'Помогает спланировать систему привычек.',
    requiredContext: ['habits'],
    allowedTools:   ['create_habit', 'get_habits'],
    canCombine: false, priority: 5,
    prompt: `Режим: ПЛАН ПРИВЫЧЕК\n\nПомоги создать сбалансированную систему привычек. Учти текущие привычки из контекста. Предложи не более 3 новых привычек с конкретным расписанием.`,
  },
  {
    id:          'habits.review',
    domain:      'habits',
    description: 'Анализирует прогресс и стабильность привычек.',
    requiredContext: ['habits'],
    allowedTools:   ['get_habits'],
    canCombine: false, priority: 5,
    prompt: `Режим: ОБЗОР ПРИВЫЧЕК\n\nПроанализируй прогресс по привычкам из контекста. Выдели сильные стороны и точки роста. Покажи, какие привычки выполняются стабильно, а какие требуют внимания.`,
  },
  {
    id:          'habits.recovery',
    domain:      'habits',
    description: 'Помогает восстановить привычки после перерыва.',
    requiredContext: ['habits'],
    allowedTools:   ['get_habits'],
    canCombine: false, priority: 5,
    prompt: `Режим: ВОССТАНОВЛЕНИЕ ПРИВЫЧЕК\n\nПомоги вернуться к привычкам после перерыва. Предложи план постепенного восстановления. Не пытайся вернуть всё сразу — 1-2 привычки как точка входа.`,
  },
  {
    id:          'notes.find',
    domain:      'notes',
    description: 'Ищет нужную заметку по теме или ключевым словам.',
    requiredContext: ['notes'],
    allowedTools:   ['search_notes'],
    canCombine: false, priority: 5,
    prompt: `Режим: ПОИСК ЗАМЕТКИ\n\nИщи нужную заметку через search_notes с релевантными ключевыми словами из запроса пользователя. Покажи найденные заметки с превью. Если ничего не нашлось — скажи об этом честно.`,
  },
  {
    id:          'notes.summarize',
    domain:      'notes',
    description: 'Делает краткое резюме заметок.',
    requiredContext: ['notes'],
    allowedTools:   ['search_notes'],
    canCombine: false, priority: 4,
    prompt: `Режим: РЕЗЮМЕ ЗАМЕТОК\n\nСделай краткое структурированное резюме по запрошенным заметкам. Выдели ключевые идеи, факты, действия. Если нужна конкретная заметка — используй search_notes.`,
  },
  {
    id:          'notes.structure',
    domain:      'notes',
    description: 'Помогает структурировать и улучшить заметку.',
    requiredContext: ['notes'],
    allowedTools:   ['search_notes', 'update_note'],
    canCombine: false, priority: 4,
    prompt: `Режим: СТРУКТУРИРОВАНИЕ ЗАМЕТКИ\n\nПомоги улучшить структуру заметки: выдели разделы, добавь заголовки, сделай текст чище. Предложи итоговую версию. Если нужно обновить — используй update_note.`,
  },
];

// ── All skills in one map ────────────────────────────────────────────────────

const SKILL_REGISTRY = {};

for (const skill of [
  financeFullAudit,
  financeAffordability,
  financeLeaks,
  financeGoal,
  financeBudget,
  financeDebt,
  financeCashflow,
  financeMonthReview,
  financeStressTest,
  financeWhatIf,
  financeSalaryDistribution,
  financePaymentCalendar,
  tasksPlanDay,
  tasksPrioritize,
  ...FRAMEWORK_SKILLS,
]) {
  SKILL_REGISTRY[skill.id] = skill;
}

// ── Validation (fail fast on misconfiguration) ───────────────────────────────

const VALID_DOMAINS = new Set(['finance', 'tasks', 'habits', 'reminders', 'notes', 'goals', 'general']);

const VALID_TOOLS = new Set([
  'create_task', 'update_task', 'complete_task', 'search_tasks',
  'create_reminder', 'update_reminder', 'complete_reminder', 'delete_reminder', 'search_reminders',
  'create_transaction', 'search_transactions',
  'create_habit', 'complete_habit_today', 'get_habits',
  'create_note', 'update_note', 'search_notes',
]);

(function validateRegistry() {
  const seenIds = new Set();
  for (const [id, skill] of Object.entries(SKILL_REGISTRY)) {
    if (seenIds.has(id)) throw new Error(`[SkillRegistry] Duplicate skill id: ${id}`);
    seenIds.add(id);

    if (!skill.prompt) throw new Error(`[SkillRegistry] Skill ${id} missing prompt`);

    for (const d of skill.requiredContext ?? []) {
      if (!VALID_DOMAINS.has(d)) throw new Error(`[SkillRegistry] Skill ${id}: unknown domain "${d}"`);
    }
    for (const t of skill.allowedTools ?? []) {
      if (!VALID_TOOLS.has(t)) throw new Error(`[SkillRegistry] Skill ${id}: unknown tool "${t}"`);
    }
  }
})();

module.exports = { SKILL_REGISTRY };
