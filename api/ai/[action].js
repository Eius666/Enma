'use strict';

const { db, admin } = require('../_lib/firebaseAdmin');
const { rateLimit }  = require('../_lib/rateLimit');

// Mirror of src/subscription.ts AI_LIMITS
const AI_LIMITS = {
  free:    { textRequests: 0,  imageRequests: 0,  pdfReports: 0  },
  pro:     { textRequests: 20, imageRequests: 0,  pdfReports: 0  },
  premium: { textRequests: 100, imageRequests: 30, pdfReports: 10 },
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI / OpenRouter — uses OPENAI_API_KEY if set, falls back to OPENROUTER_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

function aiConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      apiKey:  process.env.OPENAI_API_KEY,
      baseURL: 'https://api.openai.com/v1',
      textModel:  'gpt-4o-mini',
      imageModel: 'dall-e-3',
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      apiKey:  process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      textModel:  'openai/gpt-4o-mini',
      imageModel: process.env.IMAGE_GEN_MODEL || 'openai/gpt-image-1',
    };
  }
  throw new Error('No AI API key configured (set OPENAI_API_KEY or OPENROUTER_API_KEY)');
}

async function callText(messages, systemPrompt, maxTokens = 1000) {
  const cfg = aiConfig();
  const resp = await fetch(`${cfg.baseURL}/chat/completions`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:      cfg.textModel,
      messages:   [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function callImage(prompt) {
  const cfg = aiConfig();
  const resp = await fetch(`${cfg.baseURL}/images/generations`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.imageModel, prompt, n: 1, size: '1024x1024' }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Image API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    url:           data.data?.[0]?.url ?? null,
    revisedPrompt: data.data?.[0]?.revised_prompt ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getActivePlan(userId) {
  const snap = await db.collection('subscriptions').doc(userId).get();
  if (!snap.exists) return 'free';
  const sub = snap.data();
  if (sub.status !== 'active') return 'free';

  // Trial: plan == 'free' + trialPlan set + trialEndDate in future
  if (sub.plan === 'free' && sub.trialPlan && sub.trialEndDate) {
    if (new Date(sub.trialEndDate) > new Date()) return sub.trialPlan;
  }

  // Paid plan expiry — support both endDateMs (ms) and expiresAt (Timestamp)
  const endMs = sub.endDateMs ?? sub.expiresAt?.toMillis?.() ?? 0;
  if (endMs && endMs < Date.now()) return 'free';

  return sub.plan ?? 'free';
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage counter — atomic read+increment via Firestore transaction
// Returns { allowed, used, limit, remaining }
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndIncrement(userId, field, plan) {
  const limit = AI_LIMITS[plan]?.[field] ?? 0;
  if (limit === 0) return { allowed: false, used: 0, limit: 0, remaining: 0 };

  const ref   = db.collection('aiUsage').doc(userId);
  const month = currentMonth();
  let result  = { allowed: false, used: 0, limit, remaining: 0 };

  await db.runTransaction(async tx => {
    const snap     = await tx.get(ref);
    const data     = snap.exists ? snap.data() : {};
    const sameMonth = data.month === month;
    const used     = sameMonth ? (data[field] ?? 0) : 0;

    if (used >= limit) {
      result = { allowed: false, used, limit, remaining: 0 };
      return;
    }

    if (sameMonth) {
      tx.set(ref, { [field]: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } else {
      // New month — reset all counters, set only the relevant one
      tx.set(ref, {
        userId,
        month,
        textRequests:  field === 'textRequests'  ? 1 : 0,
        imageRequests: field === 'imageRequests' ? 1 : 0,
        pdfReports:    field === 'pdfReports'    ? 1 : 0,
        updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    result = { allowed: true, used: used + 1, limit, remaining: limit - used - 1 };
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit helpers (in-memory / Vercel KV via _lib/rateLimit.js)
// ─────────────────────────────────────────────────────────────────────────────

async function checkRate(userId, type) {
  const windowMs = type === 'image' ? 30_000 : 10_000;
  const allowed  = await rateLimit(`ai_${type}:${userId}`, 1, windowMs);
  return allowed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared error helpers
// ─────────────────────────────────────────────────────────────────────────────

function sendLimit(res, used, limit) {
  return res.status(429).json({ error: 'Monthly limit exceeded', code: 'monthly_limit', used, limit });
}

function sendPlanRestricted(res) {
  return res.status(429).json({ error: 'Feature not available on your plan', code: 'plan_restricted' });
}

function sendRateLimit(res, type) {
  const retryAfterMs = type === 'image' ? 30_000 : 10_000;
  return res.status(429).json({ error: 'Too many requests', code: 'rate_limit', retryAfterMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

const ANALYZE_SYSTEM = `You are a financial analysis assistant. Analyze the provided transactions and return a JSON object with exactly this structure:
{
  "summary": "Brief overall assessment (1-2 sentences in Russian)",
  "insights": ["insight 1 in Russian", "insight 2 in Russian", "insight 3 in Russian"],
  "topCategory": "Category name with highest spending",
  "savingSuggestion": "One specific actionable saving tip in Russian"
}
Return ONLY the JSON object. No markdown fences, no explanation.`;

async function handleAnalyze(req, res) {
  const { userId, transactions, month } = req.body ?? {};
  if (!userId || !Array.isArray(transactions)) {
    return res.status(400).json({ error: 'Missing userId or transactions' });
  }

  const plan = await getActivePlan(userId);

  const isAllowed = await checkRate(userId, 'text');
  if (!isAllowed) return sendRateLimit(res, 'text');

  const usage = await checkAndIncrement(userId, 'textRequests', plan);
  if (!usage.allowed) {
    return usage.limit === 0 ? sendPlanRestricted(res) : sendLimit(res, usage.used, usage.limit);
  }

  try {
    const txSummary = transactions.slice(0, 50).map(t =>
      `${t.date ?? ''} | ${t.category ?? 'other'} | ${t.amount ?? 0} ${t.currency ?? ''} | ${t.note ?? ''}`
    ).join('\n');

    const content = await callText(
      [{ role: 'user', content: `Month: ${month ?? currentMonth()}\nTransactions:\n${txSummary}` }],
      ANALYZE_SYSTEM,
      800,
    );

    let result;
    try {
      result = JSON.parse(content.replace(/```json\n?|```/g, '').trim());
    } catch {
      result = { summary: content, insights: [], topCategory: '', savingSuggestion: '' };
    }

    return res.status(200).json({ ...result, remaining: usage.remaining });
  } catch (err) {
    console.error('[ai/analyze] error:', err.message);
    return res.status(500).json({ error: 'Analysis failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const CHAT_SYSTEM = `Ты — Энма, финансовый помощник пользователя в мобильном приложении.

Личность:
- Говоришь живо и по-человечески, без канцеляризмов
- Короткие ответы, максимум 3-4 предложения
- Не пишешь "Конечно!", "Без проблем!", "Я рада помочь!"
- Не называешь себя ИИ или ассистентом
- Отвечаешь на русском

Ты помогаешь с финансами: анализируешь расходы, даёшь советы по бюджету, объясняешь финансовые понятия. Отвечай кратко и по делу.`;

async function handleChat(req, res) {
  const { userId, message, history } = req.body ?? {};
  if (!userId || !message) {
    return res.status(400).json({ error: 'Missing userId or message' });
  }

  const plan = await getActivePlan(userId);

  const isAllowed = await checkRate(userId, 'text');
  if (!isAllowed) return sendRateLimit(res, 'text');

  const usage = await checkAndIncrement(userId, 'textRequests', plan);
  if (!usage.allowed) {
    return usage.limit === 0 ? sendPlanRestricted(res) : sendLimit(res, usage.used, usage.limit);
  }

  try {
    const historyMsgs = (Array.isArray(history) ? history.slice(-10) : [])
      .map(m => ({ role: m.role, content: m.content }));

    const content = await callText(
      [...historyMsgs, { role: 'user', content: message }],
      CHAT_SYSTEM,
      600,
    );

    // Persist to Firestore (best-effort, non-fatal)
    try {
      const chatRef = db.collection('users').doc(userId).collection('aiChats');
      const now     = admin.firestore.FieldValue.serverTimestamp();
      const batch   = db.batch();
      batch.set(chatRef.doc(), { role: 'user',      content: message, createdAt: now });
      batch.set(chatRef.doc(), { role: 'assistant', content,          createdAt: now });
      await batch.commit();
    } catch (fsErr) {
      console.warn('[ai/chat] Firestore persist failed:', fsErr.message);
    }

    return res.status(200).json({ message: content, remaining: usage.remaining });
  } catch (err) {
    console.error('[ai/chat] error:', err.message);
    return res.status(500).json({ error: 'Chat failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleImage(req, res) {
  const { userId, prompt } = req.body ?? {};
  if (!userId || !prompt) {
    return res.status(400).json({ error: 'Missing userId or prompt' });
  }

  const plan = await getActivePlan(userId);

  const isAllowed = await checkRate(userId, 'image');
  if (!isAllowed) return sendRateLimit(res, 'image');

  const usage = await checkAndIncrement(userId, 'imageRequests', plan);
  if (!usage.allowed) {
    return usage.limit === 0 ? sendPlanRestricted(res) : sendLimit(res, usage.used, usage.limit);
  }

  try {
    const result = await callImage(prompt);
    return res.status(200).json({ ...result, remaining: usage.remaining });
  } catch (err) {
    console.error('[ai/image] error:', err.message);
    return res.status(500).json({ error: 'Image generation failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const REPORT_SYSTEM = `You are a financial report generator. Create a structured HTML financial summary based on the provided data. Use Russian language. Include sections for: overall summary, top spending categories, notable trends, and 2-3 actionable recommendations. Use simple inline CSS for readability (dark-friendly: background #1a1a2e, text #e0e0e0, accent #a29bfe). Return ONLY the HTML fragment — no doctype, html, head, or body tags.`;

async function handleReport(req, res) {
  const { userId, data } = req.body ?? {};
  if (!userId || !data) {
    return res.status(400).json({ error: 'Missing userId or data' });
  }

  const plan = await getActivePlan(userId);

  const isAllowed = await checkRate(userId, 'text');
  if (!isAllowed) return sendRateLimit(res, 'text');

  const usage = await checkAndIncrement(userId, 'pdfReports', plan);
  if (!usage.allowed) {
    return usage.limit === 0 ? sendPlanRestricted(res) : sendLimit(res, usage.used, usage.limit);
  }

  try {
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const html = await callText(
      [{ role: 'user', content: `Financial data:\n${dataStr.slice(0, 3000)}` }],
      REPORT_SYSTEM,
      2000,
    );

    return res.status(200).json({ html, remaining: usage.remaining });
  } catch (err) {
    console.error('[ai/report] error:', err.message);
    return res.status(500).json({ error: 'Report generation failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.query;

  try {
    switch (action) {
      case 'analyze': return await handleAnalyze(req, res);
      case 'chat':    return await handleChat(req, res);
      case 'image':   return await handleImage(req, res);
      case 'report':  return await handleReport(req, res);
      default:
        return res.status(404).json({ error: `Unknown AI action: ${action}` });
    }
  } catch (err) {
    console.error(`[ai/${action}] unhandled error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
