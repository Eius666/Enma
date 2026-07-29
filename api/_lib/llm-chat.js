'use strict';

const { TOOL_DEFINITIONS, executeTool, getUserTimezone } = require('./tools');

const OR_BASE = 'https://openrouter.ai/api/v1';

const SYSTEM_PROMPT = `Ты — Enma, умный персональный ассистент в Telegram. Ты помогаешь пользователю с финансами, задачами, напоминаниями и любыми вопросами.

Твои возможности:
💬 Отвечать на вопросы
🔍 Искать информацию в интернете (курсы валют, погода, новости)
⏰ Создавать напоминания
📋 Создавать задачи в календаре
💰 Записывать расходы и доходы
📊 Показывать историю

Правила:
1. Всегда используй инструменты когда пользователь просит что-то сделать.
2. Часовой пояс пользователя: {{TIMEZONE}}. Текущее время UTC: {{CURRENT_TIME}}.
3. Отвечай на русском, будь дружелюбным и кратким.
4. НЕ придумывай данные — если не знаешь, используй search_web.

КРИТИЧЕСКИ ВАЖНО — поле scheduledAt в create_reminder:
Значение ОБЯЗАТЕЛЬНО должно быть строкой ISO 8601 UTC с суффиксом Z.
Формат: "YYYY-MM-DDTHH:MM:00Z"

Алгоритм конвертации:
1. Узнай, какое время хочет пользователь в его часовом поясе ({{TIMEZONE}}).
2. Вычти смещение UTC для этого пояса.
3. Запиши результат с суффиксом Z.

Пример: пользователь говорит "в 21:00", его пояс {{TIMEZONE}} = UTC+2 летом.
21:00 local − 2ч = 19:00 UTC → scheduledAt = "2026-07-30T19:00:00Z"

ЗАПРЕЩЕНО передавать в scheduledAt:
- Описания на русском ("через час", "завтра", "сегодня вечером")
- Даты без суффикса Z ("2026-07-30T20:00", "2026-07-30 20:00")
- null, undefined или пустую строку`;

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
  const timezone = await getUserTimezone(userId).catch(() => 'Europe/Warsaw');
  const system   = { role: 'system', content: buildSystemPrompt(timezone) };
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
        result = await executeTool(name, args, userId, chatId, timezone);
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

  // Final synthesis: no tools, just summarise results
  const finalData = await callLLM(conversation, []);
  const finalMsg  = finalData?.choices?.[0]?.message;
  const text      = finalMsg?.content ?? finalMsg?.reasoning ?? '';

  return { text, toolCalls: toolResults };
}

module.exports = { chatWithTools, searchWeb, callLLM, extractJSON };
