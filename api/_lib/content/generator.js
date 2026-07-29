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

const REGEN_SUFFIX = `\n\nЭТО РЕГЕНЕРАЦИЯ. Предложи РАДИКАЛЬНО другую тему и угол подачи.
Не вариируй предыдущую идею — предлагай совершенно другой подход, другую эмоцию, другой формат.
Если раньше был юмор — попробуй практику. Если был мем — попробуй кейс. Удиви.`;

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
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!match) throw new Error('No JSON in LLM response: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
}

// ── Standard idea generation (daily planner) ─────────────────────────────────

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

// ── Regenerate a single idea, excluding already-rejected ones ─────────────────
// excludedIdeas: string[] — titles/angles of previously rejected ideas

async function regenerateIdea(excludedIdeas = []) {
  const exclusionBlock = excludedIdeas.length > 0
    ? `\nУЖЕ ОТВЕРГНУТЫЕ ИДЕИ (не повторять, даже косвенно):\n${excludedIdeas.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';

  const prompt = `${exclusionBlock}Придумай 1 новую идею для поста в Telegram/Threads для Enma.
Предложи РАДИКАЛЬНО другую тему: другая эмоция, другой формат, другой угол.

Верни JSON (без обёртки):
{
  "title": "Короткое название (макс 60 символов)",
  "angle": "Угол подачи — что именно говорим и как (1–2 предложения)",
  "format": "single"
}`;

  const raw = await llmCall(
    [{ role: 'user', content: prompt }],
    CONTENT_SYSTEM_PROMPT + REGEN_SUFFIX,
    14_000
  );
  return extractJson(raw);
}

// ── Generate full post text ───────────────────────────────────────────────────

async function generatePost(idea, timeoutMs = 14_000) {
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

  const raw = await llmCall([{ role: 'user', content: prompt }], CONTENT_SYSTEM_PROMPT, timeoutMs);
  return extractJson(raw);
}

// ── Regenerate post text for an existing idea (text_only mode) ────────────────
// Returns same shape as generatePost but with a different text angle.

async function regeneratePost(idea, timeoutMs = 14_000) {
  const prompt = `Напиши НОВЫЙ вариант поста для той же идеи, но с другим текстом и другим крючком:
Тема: "${idea.title}"
Угол: "${idea.angle}"

Требование: не повторяй предыдущий текст. Смени крючок, структуру, тон.
Если раньше был юмор — попробуй конкретный факт. Если вопрос — попробуй утверждение.

Threads-версия (строго 150–280 символов), Telegram-версия (до 500 символов).
Новый prompt для DALL-E с другой визуальной метафорой.

Верни JSON (без обёртки):
{
  "threadsText": "...",
  "telegramText": "...",
  "imagePrompt": "..."
}`;

  const raw = await llmCall(
    [{ role: 'user', content: prompt }],
    CONTENT_SYSTEM_PROMPT + REGEN_SUFFIX,
    timeoutMs
  );
  return extractJson(raw);
}

// ── Generate image from a DALL-E–style prompt ─────────────────────────────────
// Uses OpenRouter's /v1/images/generations endpoint.
// Returns a public image URL, or throws on failure.

async function generateImage(imagePrompt, timeoutMs = 14_000) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const model = process.env.IMAGE_GEN_MODEL || 'openai/dall-e-3';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://enma.app',
        'X-Title': 'Enma-Content',
      },
      body: JSON.stringify({ model, prompt: imagePrompt, n: 1, size: '1024x1024' }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Image API ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const url  = data?.data?.[0]?.url;
    if (!url) throw new Error('No image URL in response');
    return url;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateIdeas, generatePost, regenerateIdea, regeneratePost, generateImage, llmCall, extractJson };
