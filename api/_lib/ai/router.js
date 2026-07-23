'use strict';

const openrouter = require('./openrouter-client');

// All models routed through OpenRouter. IDs are env-configurable so they
// can be swapped without a code deploy.
const MODELS = [
  { id: process.env.OPENROUTER_PRIMARY_MODEL     || 'google/gemini-2.5-flash',    name: 'primary'    },
  { id: process.env.OPENROUTER_FALLBACK_MODEL    || 'anthropic/claude-sonnet-4',  name: 'fallback'   },
  { id: process.env.OPENROUTER_LAST_RESORT_MODEL || 'google/gemini-2.5-flash',    name: 'last_resort' },
];

/**
 * Route a chat request through models with automatic fallback.
 * All requests go through OpenRouter — one key, three models.
 *
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} [systemPrompt]
 * @returns {Promise<{ response: string, provider: string, model: string }>}
 */
async function routeMessage(messages, systemPrompt) {
  let lastError;

  for (const { id, name } of MODELS) {
    if (!id) continue; // skip if env var not set
    try {
      const response = await openrouter.chat(messages, id, systemPrompt);
      return { response, provider: name, model: id };
    } catch (err) {
      console.error('[router]', name, '(' + id + ') failed — status:', err.status ?? 'N/A', '| msg:', err.message);
      lastError = err;
    }
  }

  throw lastError ?? new Error('[router] No models configured');
}

// The tool-use model: Claude reliably supports function calling via OpenRouter.
// Falls back to regular routeMessage (no tools) if tool-use chat fails entirely.
const TOOLS_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || 'anthropic/claude-sonnet-4';

/**
 * Route a message with tool use support.
 * Uses Claude for tool calling; falls back to plain text routing on failure.
 *
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} [systemPrompt]
 * @param {Array} tools — OpenAI-format tool definitions
 * @param {(name: string, input: object) => Promise<object>} execFn
 * @returns {Promise<{ response: string, provider: string, model: string }>}
 */
async function routeMessageWithTools(messages, systemPrompt, tools, execFn) {
  try {
    const response = await openrouter.chatWithTools(messages, TOOLS_MODEL, systemPrompt, tools, execFn);
    return { response, provider: 'tools', model: TOOLS_MODEL };
  } catch (err) {
    console.error('[router:tools] failed — status:', err.status ?? 'N/A', '| msg:', err.message, '— falling back to plain routing');
    return routeMessage(messages, systemPrompt);
  }
}

module.exports = { routeMessage, routeMessageWithTools };
