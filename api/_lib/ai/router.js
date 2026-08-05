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

module.exports = { routeMessage };
