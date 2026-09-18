'use strict';

const { SKILL_REGISTRY } = require('./skills/registry');
const { CORE_PROMPT }    = require('./skills/core');

// ── Rule-based trigger tables ────────────────────────────────────────────────
// Maps skill ID → array of lowercase substrings. Any match → skill selected.

const SKILL_PATTERNS = {
  'finance.full_audit': [
    'полный финансовый', 'финансовый аудит', 'аудит расходов',
    'аудит финансов', 'разбери мои финансы', 'разбери финансы',
    'полный анализ финансов', 'полную картину финансов',
    'полный разбор финансов', 'финансовый разбор',
    'хочу понять полную картину',
  ],
  'finance.affordability': [
    'могу ли я купить', 'могу ли купить', 'могу ли позволить',
    'могу позволить', 'потяну ли', 'смогу купить',
    'хватит ли денег на', 'можно ли мне сейчас потратить',
    'могу потратить', 'позволю ли', 'могу себе позволить',
    'могу ли я потратить', 'могу ли потратить',
  ],
  'finance.leaks': [
    'куда уходят деньги', 'куда у меня уходят деньги',
    'найди лишние траты', 'лишние траты',
    'где я переплачиваю', 'найди утечки', 'утечки бюджета',
    'что я переплачиваю', 'куда я трачу', 'куда утекают деньги',
    'ненужные расходы', 'лишние расходы',
  ],
  'finance.goal': [
    'хочу накопить', 'сколько откладывать', 'когда накоплю',
    'накопить на ', 'сколько нужно откладывать',
    'когда я накоплю', 'план накопления', 'цель накопления',
    'сколько мне нужно откладывать', 'план сбережений',
  ],
  'finance.budget': [
    'составь бюджет', 'план расходов', 'бюджет на месяц',
    'распредели расходы', 'составить бюджет', 'сделай бюджет',
    'пересобери мой бюджет', 'какие лимиты поставить',
    'сколько мне можно тратить по категориям', 'бюджет на следующий месяц',
  ],
  'finance.month_review': [
    'как прошёл месяц', 'итоги месяца', 'что по деньгам за месяц',
    'финансовые итоги', 'итоги по деньгам', 'разбери мои расходы за',
    'что изменилось по сравнению с прошлым месяцем',
    'подведи итоги месяца', 'что было в этом месяце с деньгами',
  ],
  'finance.cashflow': [
    'хватит ли мне денег до зарплаты', 'хватит ли денег до зарплаты',
    'сколько останется к концу месяца', 'что будет с балансом',
    'когда у меня закончатся деньги', 'есть ли риск кассового разрыва',
    'кассовый разрыв', 'когда приходит зарплата', 'денежный поток',
    'cashflow', 'кэшфлоу', 'хватит до зарплаты', 'дотяну до зарплаты',
    'сколько осталось до зарплаты',
  ],
  'finance.stress_test': [
    'стресс-тест', 'если потеряю работу', 'если уволят',
    'финансовая подушка', 'сколько продержусь', 'финансовая устойчивость',
    'насколько устойчивы мои финансы', 'хватит ли подушки',
    'что если потеряю доход', 'останусь без зарплаты',
    'без дохода на', 'сделай стресс тест', 'без работы на',
    'потеряю доход',
  ],
  'finance.what_if': [
    'а если зарплата', 'что если зарплата', 'а если доход',
    'что если доход', 'буду откладывать', 'если откладывать на',
    'а если перестану тратить', 'если сократить расходы на',
    'как изменится если', 'что если я буду', 'если зарплата вырастет',
    'если зарплата упадёт',
  ],
  'finance.debt': [
    'как быстрее закрыть долг', 'погасить кредит', 'как погасить',
    'что гасить первым', 'снежный ком', 'лавина погашения',
    'сколько я переплачу', 'долговая нагрузка', 'закрыть долги',
    'какой кредит', 'стратегия погашения долга', 'кредиты и долги',
    'закрыть кредит', 'гасить долг',
  ],
  'finance.salary_distribution': [
    'распредели зарплату', 'как распределить зарплату', 'по конвертам',
    'распределить доход', 'конверты бюджет', 'куда потратить зарплату',
    'что делать с зарплатой', 'распредели мою следующую зарплату',
    'сколько отложить после зарплаты', 'куда разложить деньги после зарплаты',
  ],
  'finance.payment_calendar': [
    'какие платежи у меня впереди', 'составь календарь платежей',
    'что спишется в этом месяце', 'какие крупные расходы скоро',
    'платёжный календарь', 'какие платежи ждут',
    'платежи до конца месяца', 'предстоящие платежи',
    'когда ближайший крупный платёж', 'крупные платежи ждут',
  ],
  'tasks.plan_day': [
    'спланируй', 'спланировать день',
    'план на день', 'план на сегодня',
    'что мне сегодня лучше сделать', 'разложи задачи на сегодня',
    'составь план дня', 'расставь задачи на сегодня',
    'помоги спланировать', 'распланируй',
  ],
  'tasks.prioritize': [
    'расставь приоритеты', 'по приоритету', 'по приоритетам',
    'приоритизир', 'что важнее', 'с чего начать',
    'что из задач важнее', 'приоритеты задач', 'что сначала',
    'что делать в первую очередь', 'что срочнее',
    'расставить приоритеты',
  ],
  'tasks.break_down': [
    'разбей задачу', 'разбить на подзадачи', 'декомпозируй',
    'декомпозиция задачи', 'разложи задачу на шаги',
  ],
  'tasks.review': [
    'обзор задач', 'что выполнено', 'итоги по задачам',
    'просроченные задачи', 'задачи за неделю',
  ],
  'habits.review': [
    'анализ привычек', 'как у меня с привычками', 'прогресс привычек',
    'обзор привычек', 'статистика привычек',
  ],
  'habits.recovery': [
    'вернуться к привычкам', 'восстановить привычки', 'после перерыва',
    'снова начать привычки',
  ],
  'habits.create_plan': [
    'план привычек', 'система привычек', 'создать план привычек',
    'какие привычки завести',
  ],
  'notes.find': [
    'найди заметку', 'поищи заметку', 'найди запись',
    'есть ли у меня заметка', 'найди мою заметку',
  ],
};

// ── History skill extraction ─────────────────────────────────────────────────
// Look at last 2 user turns for recently used skills (follow-up preservation).

function extractHistorySkillIds(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const recent = history
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => String(m.content ?? '').toLowerCase());

  const found = new Set();
  for (const text of recent) {
    for (const [skillId, patterns] of Object.entries(SKILL_PATTERNS)) {
      if (patterns.some(p => text.includes(p))) found.add(skillId);
    }
  }
  return [...found];
}

// ── Rule-based fast path ─────────────────────────────────────────────────────

function routeSkillByRules(message, history) {
  const lc = message.toLowerCase();

  const matched = new Set();
  for (const [skillId, patterns] of Object.entries(SKILL_PATTERNS)) {
    if (patterns.some(p => lc.includes(p))) matched.add(skillId);
  }

  // full_audit absorbs all other finance skills — don't double-up
  if (matched.has('finance.full_audit')) {
    for (const sub of [
      'finance.leaks', 'finance.budget', 'finance.goal', 'finance.month_review',
      'finance.cashflow', 'finance.stress_test', 'finance.salary_distribution',
      'finance.payment_calendar', 'finance.debt', 'finance.what_if',
    ]) {
      matched.delete(sub);
    }
  }

  if (matched.size > 0) {
    return {
      skillIds:   [...matched],
      confidence: matched.size >= 2 ? 0.85 : 0.92,
      source:     'rules',
    };
  }

  // Short follow-up: inherit skill from history if message ≤ 7 words
  const wordCount = lc.trim().split(/\s+/).length;
  if (wordCount <= 7) {
    const historySkills = extractHistorySkillIds(history);
    if (historySkills.length > 0) {
      return { skillIds: historySkills, confidence: 0.70, source: 'history' };
    }
  }

  return null; // no skill matched — caller decides LLM fallback or no-skill
}

// ── Public API ───────────────────────────────────────────────────────────────

const VALID_SKILL_IDS = new Set(Object.keys(SKILL_REGISTRY));

// Resolves skill IDs to full skill objects, filtering unknown IDs (whitelist).
function resolveSkills(skillIds) {
  return (skillIds ?? [])
    .map(id => SKILL_REGISTRY[id])
    .filter(Boolean);
}

// Returns merged domains: context-router domains ∪ all skills' requiredContext.
function mergeContextDomains(routerDomains, skills) {
  const merged = new Set(Array.isArray(routerDomains) ? routerDomains : []);
  for (const skill of skills) {
    for (const d of skill.requiredContext ?? []) merged.add(d);
  }
  return [...merged];
}

// Returns filtered tool definitions for the active skill set.
// If no skills → falls back to domain-based filtering (imported from contextRouter).
function getToolsForSkills(allDefs, domains, skills, getToolsForDomainsFn) {
  if (!skills || skills.length === 0) {
    return getToolsForDomainsFn(allDefs, domains);
  }
  const allowed = new Set();
  for (const skill of skills) {
    for (const toolName of skill.allowedTools ?? []) allowed.add(toolName);
  }
  if (allowed.size === 0) return [];
  return allDefs.filter(def => allowed.has(def.function?.name ?? ''));
}

// Composes final system prompt: CORE + skill prompt(s) + stateSection + userContext + calculatedMetrics.
// stateSection (optional string) — compact [CONVERSATION STATE] block from conversationState.js.
// calculatedMetrics (optional string) — output of runFinanceEngine, appended last.
function composeSystemPrompt(skills, userContext, calculatedMetrics, stateSection) {
  const parts = [CORE_PROMPT];
  for (const skill of skills) {
    if (skill.prompt) parts.push(skill.prompt);
  }
  if (stateSection) parts.push(stateSection);
  if (userContext) parts.push(userContext);
  if (calculatedMetrics) parts.push(calculatedMetrics);
  return parts.join('\n\n');
}

// Main entry point.
// Returns { skillIds, skills, confidence, source } — never throws.
function routeSkill({ message, history, domains: _domains }) {
  const result = routeSkillByRules(message, history);
  if (result) {
    return {
      ...result,
      skills: resolveSkills(result.skillIds),
    };
  }
  return { skillIds: [], skills: [], confidence: 1.0, source: 'rules' };
}

module.exports = {
  routeSkill,
  resolveSkills,
  mergeContextDomains,
  getToolsForSkills,
  composeSystemPrompt,
  VALID_SKILL_IDS,
};
