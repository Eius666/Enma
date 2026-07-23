'use strict';

const OpenAI = require('openai');

const CLAUDE_MODEL  = process.env.OPENROUTER_ANALYTICS_MODEL || 'anthropic/claude-sonnet-4';
const GEMINI_MODEL  = process.env.OPENROUTER_FALLBACK_MODEL  || 'google/gemini-2.5-flash';
// Keep under Vercel Hobby's 10 s function limit so the error can be caught and
// reported to the user before the process is killed.
const TIMEOUT_MS    = 8_000;

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('[openrouter] OPENROUTER_API_KEY not configured');
    _client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: TIMEOUT_MS,
      defaultHeaders: {
        'HTTP-Referer': 'https://enma.app',
        'X-Title': 'Enma',
      },
    });
  }
  return _client;
}

// U+2028 Line Separator / U+2029 Paragraph Separator crash HTTP ByteString encoding
const UNSAFE_UNICODE_RE = /[\u2028\u2029]/g;

function sanitizeStr(s) {
  return typeof s === 'string' ? s.replace(UNSAFE_UNICODE_RE, '\n') : s;
}

function sanitizeMessages(msgs) {
  return msgs.map(m => ({ ...m, content: sanitizeStr(m.content) }));
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} model  -- full OpenRouter model string
 * @param {string} [systemPrompt]
 * @returns {Promise<string>}
 */
async function chat(messages, model, systemPrompt) {
  const client = getClient();

  const cleanSystem   = sanitizeStr(systemPrompt);
  const cleanMessages = sanitizeMessages(messages);

  const fullMessages = cleanSystem
    ? [{ role: 'system', content: cleanSystem }, ...cleanMessages]
    : cleanMessages;

  const completion = await client.chat.completions.create({
    model,
    messages: fullMessages,
    max_tokens: 1024,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    console.error('[openrouter] unexpected response from', model, JSON.stringify(completion).slice(0, 300));
    throw new Error('[openrouter] unexpected response from ' + model);
  }
  return content;
}

/**
 * Chat with tool use support. Runs the tool-call loop until the model
 * produces a text response or maxSteps is reached.
 *
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} model
 * @param {string|undefined} systemPrompt
 * @param {Array} tools  — OpenAI-format tool definitions
 * @param {(name: string, input: object) => Promise<object>} execFn — tool executor
 * @param {number} [maxSteps=5]
 * @returns {Promise<string>}
 */
async function chatWithTools(messages, model, systemPrompt, tools, execFn, maxSteps = 5) {
  const client      = getClient();
  const cleanSystem = sanitizeStr(systemPrompt);

  const history = [
    ...(cleanSystem ? [{ role: 'system', content: cleanSystem }] : []),
    ...sanitizeMessages(messages),
  ];

  for (let step = 0; step < maxSteps; step++) {
    const completion = await client.chat.completions.create({
      model,
      messages: history,
      tools,
      tool_choice: 'auto',
      max_tokens: 1024,
    });

    const choice = completion.choices?.[0];
    if (!choice) throw new Error('[openrouter:tools] empty response');

    const { finish_reason, message } = choice;
    const hasCalls = finish_reason === 'tool_calls' || message.tool_calls?.length > 0;

    if (hasCalls) {
      history.push(message); // assistant message with tool_calls
      for (const tc of message.tool_calls ?? []) {
        let result;
        try {
          const args = JSON.parse(tc.function.arguments);
          result = await execFn(tc.function.name, args);
        } catch (err) {
          result = { ok: false, error: err.message };
          console.error('[openrouter:tools] tool error:', tc.function.name, err.message);
        }
        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    // Text response
    const content = message.content;
    if (typeof content !== 'string') {
      console.error('[openrouter:tools] unexpected non-text response from', model, 'finish_reason:', finish_reason, 'content type:', typeof content);
      throw new Error('[openrouter:tools] unexpected non-text response');
    }
    return content;
  }

  throw new Error('[openrouter:tools] exceeded max steps (' + maxSteps + ')');
}

module.exports = { chat, chatWithTools, CLAUDE_MODEL, GEMINI_MODEL };
