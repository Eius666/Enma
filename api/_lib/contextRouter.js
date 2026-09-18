'use strict';

// ── Domain → tool names ────────────────────────────────────────────────────────
// Each domain lists the tool names available for that domain.
// handleChat filters TOOL_DEFINITIONS to the union of selected domain tool sets.

const DOMAIN_TOOLS = {
  finance:   ['create_transaction', 'search_transactions'],
  tasks:     ['create_task', 'update_task', 'complete_task', 'search_tasks'],
  reminders: ['create_reminder', 'update_reminder', 'complete_reminder', 'delete_reminder', 'search_reminders'],
  habits:    ['create_habit', 'complete_habit_today', 'get_habits'],
  notes:     ['create_note', 'update_note', 'search_notes'],
  goals:     [],   // read-only context; no write tools yet
  profile:   [],
  general:   [],
};

const ALL_DOMAINS = Object.keys(DOMAIN_TOOLS);

// ── Keyword pattern tables ─────────────────────────────────────────────────────
// Each entry is a lowercase substring; a domain matches if ANY substring is found.

const DOMAIN_PATTERNS = {
  finance: [
    'расход', 'трат', 'потрат', 'потратил', 'потрачено',
    'доход', 'зарплат', 'баланс', 'деньг', 'сколько денег',
    'купил', 'покупк', 'куплю', 'куп ',
    'бюджет', 'финанс', 'транзакц',
    'платёж', 'плачу', 'оплат', 'оплачу', 'выплат',
    'банк', 'карт',
    'рубл', ' руб', '₽', ' $', ' €', '€',
    'кофе', 'обед', 'ужин', 'продукт', 'ресторан', 'магазин', 'аптек',
    'перевод', 'поступл', 'прибыл', 'прибыль',
    'такси', 'uber', 'яндекс такси', 'каршеринг',
    'стоит', 'цена', 'стоимость', 'сумм',
    'бензин', 'заправк', 'коммунальн',
    'расплатил', 'заплатил', 'заплачу',
    'дорого', 'дешево', 'недорого',
    'income', 'expense',
  ],
  tasks: [
    'задач', 'задание', 'todo',
    'что нужно сделать', 'что у меня сегодня',
    'что у меня по задач', 'задачи на',
    'мои задачи', 'список дел', 'дела на',
    'дедлайн', 'срок',
    'добавь задач', 'создай задач', 'поставь задач',
    'отметь задач', 'закрой задач', 'выполни задач',
    'что у меня запланировано',
    'добавить задачу', 'создать задачу',
    'что важного сегодня', 'что нужно',
  ],
  habits: [
    'привычк', 'habit',
    'тренировк', 'бег ', 'зарядк', 'медитац',
    'ежедневн',
    'выполнил привычку', 'сделал привычку',
    'отметь привычку', 'не выполнил привычку',
    'мои привычки', 'список привычек',
  ],
  reminders: [
    'напомни', 'напомн',
    'уведомл',
    'напоминани', 'напоминание', 'напоминания',
    'поставь напоминани', 'создай напоминани',
    'будильник',
    'что у меня сегодня',  // часто ищут и задачи, и напоминания
  ],
  notes: [
    'заметк', 'заметку', 'заметки',
    'найди заметку', 'обнови заметку',
    'сохрани заметку', 'запиши заметку',
    'дневник',
  ],
  goals: [
    'цел',  // цель, цели, целью
    'коплю', 'копит', 'накопл', 'откладываю', 'сбережен',
    'могу ли я купить', 'могу позволить',
    'хватит ли', 'позволю ли',
    'достаточно денег', 'хватит денег', 'смогу купить',
    'по целям', 'мои цели',
  ],
};

// Strong signals that the query is general / educational — no personal data needed
const GENERAL_SIGNALS = [
  'что такое', 'как работает', 'объясни', 'расскажи о', 'расскажи про',
  'как устроен', 'в чём разница', 'что значит',
  'как посчитать', 'как вычислить',
  'теория ', 'история ', 'принцип',
  'что лучше', 'совет по', 'советы по',
  'как улучшить', 'как начать', 'как стать',
  'почему люди', 'почему важно',
  'сложный процент', 'инфляция ', 'биткоин', 'инвестиц', 'дивиденд',
  'курс валют', 'курс доллара',
  'расскажи мне о', 'расскажи нам',
  'что такое ',
];

// ── History domain extraction ──────────────────────────────────────────────────
// Look at last 3 user turns to find domains used in prior conversation.

function extractHistoryDomains(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const recent = history
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => String(m.content ?? '').toLowerCase());

  const domains = new Set();
  for (const text of recent) {
    for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
      if (patterns.some(p => text.includes(p))) domains.add(domain);
    }
  }
  return [...domains];
}

// ── Rule-based fast-path router ────────────────────────────────────────────────
// Returns { domains, confidence, source } or null if ambiguous.

function routeByRules(message, history) {
  const lc = message.toLowerCase();

  // Check for general/educational signal
  const isGeneralSignal = GENERAL_SIGNALS.some(p => lc.includes(p));

  // Match personal domains
  const matched = new Set();
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    if (patterns.some(p => lc.includes(p))) matched.add(domain);
  }

  // Goals affordability queries always need finance context too
  if (matched.has('goals') && !matched.has('finance')) {
    matched.add('finance');
  }

  // Pure general query (no personal domain signals)
  if (isGeneralSignal && matched.size === 0) {
    return { domains: ['general'], confidence: 0.95, source: 'rules' };
  }

  // Personal domains found in current message
  if (matched.size > 0) {
    const domains = [...matched];
    // For short follow-up messages, also consider history to preserve context
    const wordCount = lc.trim().split(/\s+/).length;
    if (wordCount <= 6) {
      for (const d of extractHistoryDomains(history)) {
        if (!domains.includes(d)) domains.push(d);
      }
    }
    return {
      domains,
      confidence: matched.size >= 2 ? 0.85 : 0.90,
      source: 'rules',
    };
  }

  // Short ambiguous follow-up — borrow domain from history
  const wordCount = lc.trim().split(/\s+/).length;
  if (wordCount <= 6) {
    const historyDomains = extractHistoryDomains(history);
    if (historyDomains.length > 0) {
      return { domains: historyDomains, confidence: 0.65, source: 'history' };
    }
  }

  return null; // truly ambiguous — caller should try LLM or use fallback
}

// ── Tool filtering ─────────────────────────────────────────────────────────────
// Returns the subset of allDefs whose function.name is allowed by any selected domain.

function getToolsForDomains(allDefs, domains) {
  if (!Array.isArray(domains) || domains.length === 0) return [];

  const allowed = new Set();
  for (const domain of domains) {
    for (const toolName of (DOMAIN_TOOLS[domain] ?? [])) {
      allowed.add(toolName);
    }
  }

  if (allowed.size === 0) return [];
  return allDefs.filter(def => allowed.has(def.function?.name ?? ''));
}

module.exports = { routeByRules, getToolsForDomains, DOMAIN_TOOLS, ALL_DOMAINS };
