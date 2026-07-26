'use strict';

// LLM-based content generation for the Enma content pipeline.
// Uses a direct fetch to OpenRouter with a longer timeout (25 s) than the
// main user-chat client (8 s) because generation runs in background crons
// and webhook callbacks, not in a latency-critical user path.

const CONTENT_SYSTEM_PROMPT = `Ты контент-менеджер для Enma — ИИ-ассистента для продуктивности и финансов.
Стиль: живой, ироничный, без канцелярита. Как у Aviasales — юмор, актуальные поводы, мемы, серии постов на одну тему.
Не пишешь «уважаемые пользователи», «рады сообщить» и прочий корпоративный мусор. Говоришь как живой человек.
Темы: ИИ, продуктивность, жизнь с нейросетями, финансы без боли, личная эффективность.
Возвращай только валидный JSON без markdown-блока \`\`\`json.`;

const DAY_NAMES_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

async function llmCall(messages, systemPrompt, timeoutMs = 25_000) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const model = process.env.OPENROUTER_PRIMARY_MODEL || 'google/gemini-2.5-flash';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://enma.app',
        'X-Title': 'Enma-Content',
      },
      body: JSON.stringify({
        model,
        messages: systemPrompt
          ? [{ role: 'system', content: systemPrompt }, ...messages]
          : messages,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`OpenRouter ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  // Strip markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error('No JSON in LLM response: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
}

async function generateIdeas(date) {
  const dayName = DAY_NAMES_RU[date.getUTCDay()];
  const dateStr = date.toLocaleDateString('ru-RU', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const prompt = `Сегодня ${dateStr} (${dayName}).

Придумай 4 идеи для постов в Telegram-канал и Threads для Enma — ИИ-ассистента.
Учитывай день недели (понедельничная тоска, пятничная эйфория, воскресный продуктив).
Актуальные AI-тренды, ироничный взгляд на жизнь с нейросетями.

Форматы:
- single: обычный пост 150–300 символов
- thread: серия 3–5 коротких постов (для Telegram-треда)
- meme: мем-пост с подписью

Верни JSON (без обёртки \`\`\`json):
{
  "ideas": [
    {
      "title": "Короткое название (макс 60 символов)",
      "angle": "Угол подачи — что именно говорим и как (1–2 предложения)",
      "format": "single"
    }
  ]
}`;

  const raw = await llmCall([{ role: 'user', content: prompt }], CONTENT_SYSTEM_PROMPT);
  const json = extractJson(raw);
  if (!Array.isArray(json.ideas)) throw new Error('Invalid ideas response');
  return json.ideas;
}

async function generatePost(idea) {
  const prompt = `Напиши пост для Telegram-канала и Threads на основе этой идеи:
Тема: "${idea.title}"
Угол: "${idea.angle}"

Threads-версия (строго 150–280 символов):
- Первое предложение = крючок, без «Привет, друзья»
- Без хэштегов
- 1–2 эмодзи к месту
- Заканчивай вопросом или CTA

Telegram-версия (до 500 символов):
- Можно чуть длиннее и с деталями
- Без хэштегов

Prompt для DALL-E (на английском, стиль flat illustration или isometric):
- Описывает визуальную метафору идеи поста

Верни JSON (без обёртки):
{
  "threadsText": "...",
  "telegramText": "...",
  "imagePrompt": "..."
}`;

  const raw = await llmCall([{ role: 'user', content: prompt }], CONTENT_SYSTEM_PROMPT);
  return extractJson(raw);
}

module.exports = { generateIdeas, generatePost, llmCall, extractJson };
