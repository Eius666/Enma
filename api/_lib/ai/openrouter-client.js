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

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} model  — full OpenRouter model string
 * @param {string} [systemPrompt]
 * @returns {Promise<string>}
 */
async function chat(messages, model, systemPrompt) {
  const client = getClient();

  const fullMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  console.log('[openrouter] model:', model, 'request sent', new Date().toISOString());
  const startMs = Date.now();

  const completion = await client.chat.completions.create({
    model,
    messages: fullMessages,
  });

  const latencyMs = Date.now() - startMs;
  console.log('[openrouter] model:', model, 'response received', new Date().toISOString(), 'latency:', latencyMs, 'ms');

  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`[openrouter] unexpected response from ${model}`);
  return content;
}

module.exports = { chat, CLAUDE_MODEL, GEMINI_MODEL };
