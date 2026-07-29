'use strict';

// Web search via Perplexity Sonar models on OpenRouter.
// Free users get perplexity/sonar, Pro users get perplexity/sonar-pro.
// Citations are returned in data.citations (array of URLs) alongside choices.

const SONAR_FREE = 'perplexity/sonar';
const SONAR_PRO  = 'perplexity/sonar-pro';
const TIMEOUT_MS = 8_000;

// Signals that suggest the user wants current/factual info from the web.
const TRIGGERS_RU = [
  'новости', 'новость', 'что происходит', 'что случилось', 'что нового',
  'какой курс', 'курс доллара', 'курс евро', 'курс рубля', 'курс биткоина',
  'погода', 'температура', 'прогноз погоды',
  'сколько стоит', 'цена на', 'цена биткоина', 'цена акций',
  'кто такой', 'кто такая', 'расскажи о', 'что такое',
  'поищи', 'найди информацию', 'поиск', 'погугли',
  'актуальный', 'актуальная', 'последние', 'свежие',
];

const TRIGGERS_EN = [
  'news', 'what happened', 'what is happening',
  'exchange rate', 'price of', 'how much does', 'how much is',
  'weather', 'temperature', 'forecast',
  'who is', 'tell me about',
  'search', 'look up', 'google',
  'latest', 'current', 'recent',
];

// If these keywords are present — keep to the normal LLM (task/finance/habit flow).
const TASK_BLOCK = [
  'задач', 'напомни', 'напоминани', 'создай задач', 'добавь задач',
  'удали задач', 'выполни задач', 'снуз', 'перенеси задач',
  'привычк', 'трекер привычек',
];

const FINANCE_BLOCK = [
  'потратил', 'заплатил', 'купил', 'потрачено', 'расход', 'трат',
  'получил', 'заработал', 'зарплат', 'запиши', 'внёс', 'занёс',
];

/**
 * Returns true when the user message looks like it needs live web data.
 * @param {string} text
 * @returns {boolean}
 */
function needsWebSearch(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  if (t.startsWith('/')) return false;

  if (TASK_BLOCK.some(kw => t.includes(kw))) return false;

  // Finance transaction detection: finance keyword + a digit = log request, not search.
  if (FINANCE_BLOCK.some(kw => t.includes(kw)) && /\d/.test(t)) return false;

  // Explicit search request always wins.
  if (/поищи|найди информацию|погугли|search for|look up/i.test(t)) return true;

  // Domain-specific triggers.
  if ([...TRIGGERS_RU, ...TRIGGERS_EN].some(kw => t.includes(kw))) return true;

  // Any question mark signals a factual query (after excluding task/finance above).
  if (t.includes('?')) return true;

  return false;
}

/**
 * Query Perplexity Sonar through OpenRouter and return the answer + citations.
 * @param {string} query
 * @param {boolean} [isPro=false]
 * @returns {Promise<{ answer: string, citations: string[] }>}
 */
async function searchWeb(query, isPro = false) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const model = isPro ? SONAR_PRO : SONAR_FREE;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://enma.app',
        'X-Title': 'Enma',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: query }],
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Perplexity ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('Empty search response');

    // Perplexity returns citations at the top level: data.citations = string[]
    const citations = Array.isArray(data?.citations) ? data.citations : [];

    return { answer, citations };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format search result for Telegram: answer + optional sources list.
 * @param {string} answer
 * @param {string[]} citations
 * @returns {string}
 */
function formatSearchResult(answer, citations) {
  if (!citations.length) return answer;
  const sources = citations.slice(0, 5).map((url, i) => `${i + 1}. ${url}`).join('\n');
  return `${answer}\n\nИсточники:\n${sources}`;
}

module.exports = { searchWeb, needsWebSearch, formatSearchResult };
