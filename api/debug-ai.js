'use strict';

// Diagnostic endpoint — tests OpenRouter API directly.
// Protected with CRON_SECRET (or open if CRON_SECRET not set, for dev convenience).
// Usage: GET /api/debug-ai  with  Authorization: Bearer <CRON_SECRET>
//        or GET /api/debug-ai?secret=<CRON_SECRET>

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const headerOk = req.headers.authorization === `Bearer ${secret}`;
    const queryOk  = req.query?.secret === secret;
    if (!headerOk && !queryOk) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const keyInfo = apiKey
    ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)} (${apiKey.length} chars)`
    : 'NOT SET';

  const envReport = {
    OPENROUTER_API_KEY:           keyInfo,
    OPENROUTER_PRIMARY_MODEL:     process.env.OPENROUTER_PRIMARY_MODEL     || '(default: google/gemini-2.5-flash)',
    OPENROUTER_FALLBACK_MODEL:    process.env.OPENROUTER_FALLBACK_MODEL    || '(default: anthropic/claude-sonnet-4)',
    OPENROUTER_LAST_RESORT_MODEL: process.env.OPENROUTER_LAST_RESORT_MODEL || '(default: google/gemini-2.5-flash)',
    TELEGRAM_BOT_TOKEN:           process.env.TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET',
    TELEGRAM_WEBHOOK_SECRET:      process.env.TELEGRAM_WEBHOOK_SECRET ? 'SET' : 'NOT SET',
    FIREBASE_SERVICE_ACCOUNT:     process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'NOT SET',
    ADMIN_TELEGRAM_IDS:           process.env.ADMIN_TELEGRAM_IDS || '(not set)',
  };

  if (!apiKey) {
    res.status(200).json({ ok: false, stage: 'env', env: envReport, error: 'OPENROUTER_API_KEY is not set' });
    return;
  }

  // Test each model sequentially and report result
  const models = [
    process.env.OPENROUTER_PRIMARY_MODEL     || 'google/gemini-2.5-flash',
    process.env.OPENROUTER_FALLBACK_MODEL    || 'anthropic/claude-sonnet-4',
    process.env.OPENROUTER_LAST_RESORT_MODEL || 'google/gemini-2.5-flash',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  const modelResults = [];

  for (const model of models) {
    const start = Date.now();
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://enma.app',
          'X-Title': 'Enma-debug',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word "ok".' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(9000),
      });

      const latency = Date.now() - start;
      let body;
      try { body = await resp.json(); } catch { body = { raw: 'non-JSON response' }; }

      if (!resp.ok) {
        modelResults.push({ model, ok: false, httpStatus: resp.status, latency, error: body });
      } else {
        const content = body?.choices?.[0]?.message?.content;
        modelResults.push({ model, ok: true, httpStatus: resp.status, latency, response: content });
      }
    } catch (err) {
      modelResults.push({ model, ok: false, latency: Date.now() - start, error: err.message });
    }
  }

  const anyOk = modelResults.some(r => r.ok);
  res.status(200).json({ ok: anyOk, env: envReport, models: modelResults });
};
