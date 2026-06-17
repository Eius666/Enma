'use strict';

const OpenAI = require('openai');

const CLAUDE_MODEL  = process.env.OPENROUTER_ANALYTICS_MODEL || 'anthropic/claude-sonnet-4';
const GEMINI_MODEL  = process.env.OPENROUTER_FALLBACK_MODEL  || 'google/gemini-2.5-flash';
const TIMEOUT_MS    = 30_000;

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

  console.log('[openrouter] model:', model, 'request sent', new Date().toISOString());
  const startMs = Date.now();

  const completion = await client.chat.completions.create({
    model,
    messages: fullMessages,
    max_tokens: 1024,
  });

  const latencyMs = Date.now() - startMs;
  console.log('[openrouter] model:', model, 'response received', new Date().toISOString(), 'latency:', latencyMs, 'ms');

  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('[openrouter] unexpected response from ' + model);
  return content;
}

module.exports = { chat, CLAUDE_MODEL, GEMINI_MODEL };
