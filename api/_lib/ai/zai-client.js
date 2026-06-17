'use strict';

// z.ai client — direct HTTP calls equivalent to z-ai-web-dev-sdk.
// We replicate the SDK's behaviour rather than using it directly because:
//   1. The SDK reads a .z-ai-config file from disk (incompatible with Vercel's
//      read-only /var/task filesystem).
//   2. The SDK is ESM-only, which conflicts with the CommonJS api/ convention.
// The wire protocol is identical: POST ${baseUrl}/chat/completions with
// Authorization: Bearer ${apiKey} and X-Z-AI-From: Z.

const BASE_URL = process.env.ZAI_BASE_URL || '';
const API_KEY  = process.env.ZAI_API_KEY  || '';
const TIMEOUT_MS = 30_000;

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {string} [systemPrompt]
 * @returns {Promise<string>}
 */
async function chat(messages, systemPrompt) {
  if (!BASE_URL || !API_KEY) throw new Error('[z.ai] ZAI_BASE_URL or ZAI_API_KEY not configured');

  const fullMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const startMs = Date.now();
  console.log('[z.ai] request sent', new Date().toISOString());

  let response;
  try {
    response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'X-Z-AI-From': 'Z',
      },
      body: JSON.stringify({
        messages: fullMessages,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('[z.ai] request timed out');
    throw err;
  }
  clearTimeout(timer);

  const latencyMs = Date.now() - startMs;
  console.log('[z.ai] response received', new Date().toISOString(), 'latency:', latencyMs, 'ms');

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[z.ai] API ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('[z.ai] unexpected response shape');
  return content;
}

module.exports = { chat };
