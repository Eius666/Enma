'use strict';

const { TOOL_DEFINITIONS, executeTool, getUserTimezone, getUserCurrency } = require('./tools');

const OR_BASE = 'https://openrouter.ai/api/v1';

const SYSTEM_PROMPT = `Ты — Enma, умный персональный ассистент в Telegram. Ты помогаешь пользователю с финансами, задачами, напоминаниями и любыми вопросами.

Твои возможности:
💬 Отвечать на вопросы
🔍 Искать информацию в интернете (курсы валют, погода, новости)
⏰ Создавать напоминания
📋 Создавать задачи в календаре
💰 Записывать расходы и доходы
📊 Показывать статистику расходов
🖼 Генерировать изображения по описанию
🔍 Анализировать отправленные изображения (vision)
🎤 Понимать голосовые сообщения (STT)
🏷 Автоматически определять категории расходов
🔁 Создавать повторяющиеся автоматизации (daily/weekly/monthly)
💬 Помнить контекст разговора (последние сообщения)

Правила:
1. Всегда используй инструменты когда пользователь просит что-то сделать.
2. Часовой пояс пользователя: {{TIMEZONE}}. Текущее время UTC: {{CURRENT_TIME}}.
3. Отвечай на русском, будь дружелюбным и кратким.
4. НЕ придумывай данные — если не знаешь, используй search_web.
5. Когда пользователь просит нарисовать/сгенерировать картинку → generate_image. Переводи описание на английский.
6. Когда пользователь спрашивает про расходы, траты, статистику, бюджет → get_finance_stats.
7. Форматирование — используй HTML-теги Telegram: <b>жирный</b> для заголовков и ключевых слов, <code>моноширинный</code> для ID/дат/чисел. НЕ используй Markdown (**, ##) — Telegram рендерит только HTML. Абзацы — не длиннее 3-4 строк, эмоджи — 1-2 на ответ.
8. Если инструмент вернул ошибку — объясни понятным языком, а не технически.

ВАЖНО для create_reminder и create_task:
Поле relative_time — передавай время ТОЧНО как сказал пользователь, без изменений.
Система сама переведёт в UTC с учётом часового пояса.

Примеры:
- "напомни через 5 минут" → relative_time: "через 5 минут"
- "напомни завтра в 9" → relative_time: "завтра в 9:00"
- "напомни в 23:30" → relative_time: "в 23:30"

НЕ вычисляй ISO timestamp самостоятельно — это задача системы.

Автоматизации (повторяющиеся действия):
- create_automation: "каждый день в 8:00 напоминай мне про таблетки", "каждый понедельник присылай мотивацию".
- list_automations: показать все активные автоматизации.
- delete_automation / pause_automation: управление (нужен ID из list_automations).
- Уточни расписание у пользователя до создания. После create_automation покажи ID — он нужен для управления.

Отправка и пересылка сообщений:
- send_message / forward_message: используй только если пользователь явно просит отправить или переслать сообщение. Уточняй chat_id если не указан.`;

function buildSystemPrompt(timezone = 'Europe/Warsaw') {
  const now = new Date().toISOString();
  return SYSTEM_PROMPT
    .replace(/\{\{TIMEZONE\}\}/g, timezone)
    .replace(/\{\{CURRENT_TIME\}\}/g, now);
}

// ── JSON extractor (handles Gemini's markdown wrapping) ───────────────────────

function extractJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (_) {}
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  const bare = str.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (bare)   try { return JSON.parse(bare[1]); } catch (_) {}
  return null;
}

// ── Core LLM call ─────────────────────────────────────────────────────────────

async function callLLM(messages, tools = [], timeoutMs = 8_000, modelOverride) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const model = modelOverride
    || process.env.OPENROUTER_PRIMARY_MODEL
    || 'google/gemini-2.5-flash';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = { model, messages, max_tokens: 1024 };
    if (tools.length > 0) { body.tools = tools; body.tool_choice = 'auto'; }

    const resp = await fetch(`${OR_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://enma.app',
        'X-Title':       'Enma',
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`OpenRouter ${resp.status}: ${err.slice(0, 200)}`);
    }

    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Web search via Perplexity Sonar ──────────────────────────────────────────

async function searchWeb(query) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const model = process.env.SEARCH_MODEL || 'perplexity/sonar';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const resp = await fetch(`${OR_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://enma.app',
        'X-Title':       'Enma',
      },
      body: JSON.stringify({
        model,
        messages:    [{ role: 'user', content: query }],
        max_tokens:  500,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`Search ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data      = await resp.json();
    const answer    = data?.choices?.[0]?.message?.content || '';
    const citations = Array.isArray(data?.citations) ? data.citations : [];

    if (!citations.length) return answer;
    const src = citations.slice(0, 5).map((u, i) => `${i + 1}. ${u}`).join('\n');
    return `${answer}\n\n📚 Источники:\n${src}`;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main chat function ────────────────────────────────────────────────────────

async function chatWithTools(userMessage, userId, chatId, history = []) {
  const [timezone, currency] = await Promise.all([
    getUserTimezone(userId).catch(() => 'Europe/Warsaw'),
    getUserCurrency(userId).catch(() => 'RUB'),
  ]);
  const system = { role: 'system', content: buildSystemPrompt(timezone) };
  const trimmed  = history.slice(-10);
  const messages = [system, ...trimmed, { role: 'user', content: userMessage }];

  // First attempt: with tools
  let data;
  try {
    data = await callLLM(messages, TOOL_DEFINITIONS);
  } catch (firstErr) {
    console.error('[llm-chat] first call failed:', firstErr.message, '— retry without tools');
    try {
      data = await callLLM(messages, []);
    } catch (secondErr) {
      console.error('[llm-chat] second call failed:', secondErr.message, '— fallback model');
      const fallback = process.env.OPENROUTER_FALLBACK_MODEL || 'anthropic/claude-sonnet-4';
      data = await callLLM(messages, [], 10_000, fallback);
    }
  }

  const choice    = data?.choices?.[0];
  if (!choice) throw new Error('Empty LLM response');

  const msg       = choice.message;
  const toolCalls = msg.tool_calls || [];

  // No tool calls — plain text response
  if (!toolCalls.length) {
    return { text: msg.content ?? msg.reasoning ?? '', toolCalls: [] };
  }

  // Execute tool calls
  const conversation  = [...messages, msg];
  const toolResults   = [];

  for (const tc of toolCalls) {
    const name = tc.function?.name;
    let args;
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (_) { args = {}; }

    let result;
    let success = true;

    try {
      if (name === 'search_web') {
        const found = await searchWeb(args.query || userMessage);
        result = { ok: true, message: found };
      } else {
        result = await executeTool(name, args, userId, chatId, timezone, currency);
      }
    } catch (err) {
      result  = { ok: false, error: err.message };
      success = false;
      console.error('[llm-chat] tool error:', name, err.message);
    }

    toolResults.push({ name, args, success, result });

    conversation.push({
      role:         'tool',
      tool_call_id: tc.id,
      content:      JSON.stringify(result),
    });
  }

  // generate_image already sent the photo to Telegram — skip synthesis to save time
  const imgResult = toolResults.find(r => r.name === 'generate_image');
  if (imgResult) {
    const msg = imgResult.result?.message || (imgResult.result?.ok === false ? `❌ ${imgResult.result.error}` : '🖼 Готово!');
    return { text: msg, toolCalls: toolResults };
  }

  // Final synthesis: no tools, just summarise results
  const finalData = await callLLM(conversation, []);
  const finalMsg  = finalData?.choices?.[0]?.message;
  const text      = finalMsg?.content ?? finalMsg?.reasoning ?? '';

  return { text, toolCalls: toolResults };
}

module.exports = { chatWithTools, searchWeb, callLLM, extractJSON };
