'use strict';

const { db, admin, getBucket } = require('../_lib/firebaseAdmin');
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
    body: JSON.stringify({
      model:           cfg.imageModel,
      prompt,
      n:               1,
      size:            '1024x1024',
      response_format: 'b64_json',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Image API error ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  const item = data.data?.[0] ?? {};
  return {
    b64:           item.b64_json ?? null,
    url:           item.url ?? null,        // fallback if model does not return b64_json
    revisedPrompt: item.revised_prompt ?? null,
  };
}

async function uploadToStorage(userId, buffer) {
  const bucket   = getBucket();
  const filename = `ai-images/${userId}/${Date.now()}.png`;
  const file     = bucket.file(filename);
  await file.save(buffer, { contentType: 'image/png', resumable: false });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${filename}`;
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

// ENTITY_COLLECTIONS / ENTITY_URL_FIELDS: maps entityType to its Firestore collection
// and the field where the persistent Storage URL is stored.
const ENTITY_COLLECTIONS = { note: 'notes', habit: 'habits' };
const ENTITY_URL_FIELDS  = { note: 'coverUrl', habit: 'iconUrl' };

async function handleImage(req, res) {
  const { userId, prompt, entityId, entityType } = req.body ?? {};
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

  // Step 1: generate image
  let imageResult;
  try {
    imageResult = await callImage(prompt);
  } catch (err) {
    console.error('[ai/image] generation error:', err.message);
    return res.status(500).json({ error: 'Image generation failed' });
  }

  if (!imageResult.b64 && !imageResult.url) {
    return res.status(500).json({ error: 'No image data returned from AI' });
  }

  // Step 2: upload to Firebase Storage (permanent URL)
  let publicUrl;
  if (imageResult.b64) {
    try {
      const buffer = Buffer.from(imageResult.b64, 'base64');
      publicUrl = await uploadToStorage(userId, buffer);
    } catch (err) {
      console.error('[ai/image] Storage upload error:', err.message);
      return res.status(500).json({ error: 'Image upload to Storage failed' });
    }
  } else {
    // Model returned a temporary URL instead of b64_json (e.g. some OpenRouter models)
    publicUrl = imageResult.url;
    console.warn('[ai/image] b64_json not returned; using temporary URL as fallback');
  }

  // Step 3: persist URL to the entity document if caller supplied entityId + entityType
  if (entityId && entityType) {
    const collection = ENTITY_COLLECTIONS[entityType];
    const field      = ENTITY_URL_FIELDS[entityType];
    if (collection && field) {
      try {
        await db.collection(collection).doc(entityId).update({ [field]: publicUrl });
      } catch (fsErr) {
        // Non-fatal: client received the URL and can store it locally
        console.warn('[ai/image] Firestore entity update failed:', fsErr.message);
      }
    }
  }

  return res.status(200).json({
    url:           publicUrl,
    revisedPrompt: imageResult.revisedPrompt,
    remaining:     usage.remaining,
  });
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
// Entity create — atomic free-limit check + document create + counter increment
// Consolidated here to stay within Vercel Hobby 12-function limit.
// ─────────────────────────────────────────────────────────────────────────────

const ENTITY_COLLECTION_MAP = {
  task:        'tasks',
  habit:       'habits',
  note:        'notes',
  transaction: 'transactions',
};

const FREE_ENTITY_CONFIG = {
  task:        { field: 'dailyTaskCount',   limit: 5,  windowField: 'date'  },
  habit:       { field: 'habitCount',       limit: 3                        },
  note:        { field: 'noteCount',        limit: 10                       },
  transaction: { field: 'transactionCount', limit: 30, windowField: 'month' },
};

const currentDate = () => new Date().toISOString().slice(0, 10);

async function handleEntityCreate(req, res) {
  const { userId, entityType, data, docId } = req.body ?? {};

  if (!userId || !entityType || !data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing userId, entityType, or data' });
  }

  const collection = ENTITY_COLLECTION_MAP[entityType];
  if (!collection) {
    return res.status(400).json({ error: `Unknown entityType: ${entityType}` });
  }

  const cfg       = FREE_ENTITY_CONFIG[entityType];
  const entityRef = docId
    ? db.collection(collection).doc(String(docId))
    : db.collection(collection).doc();
  const now     = admin.firestore.FieldValue.serverTimestamp();
  const baseDoc = { ...data, userId, createdAt: now, updatedAt: now };

  try {
    const plan   = await getActivePlan(userId);
    const isFree = plan === 'free';

    if (isFree && cfg) {
      const counterRef = db.collection('users').doc(userId)
        .collection('freeUsage').doc('counters');

      const win = cfg.windowField === 'month' ? currentMonth()
                : cfg.windowField === 'date'  ? currentDate()
                : null;

      let limitExceeded = false;
      let currentCount  = 0;

      await db.runTransaction(async tx => {
        const counterSnap = await tx.get(counterRef);
        const counterData = counterSnap.exists ? counterSnap.data() : {};

        const storedWin = win !== null ? String(counterData[cfg.windowField] ?? '') : null;
        const used = (storedWin !== null && storedWin !== win)
          ? 0
          : Number(counterData[cfg.field] ?? 0);

        currentCount = used;

        if (used >= cfg.limit) {
          limitExceeded = true;
          return;
        }

        tx.set(entityRef, baseDoc);

        const counterPatch = { userId, [cfg.field]: used + 1, updatedAt: now };
        if (win !== null) counterPatch[cfg.windowField] = win;
        tx.set(counterRef, counterPatch, { merge: true });
      });

      if (limitExceeded) {
        return res.status(429).json({
          error: 'Limit exceeded', code: 'free_limit',
          limit: cfg.limit, current: currentCount,
        });
      }
    } else {
      await entityRef.set(baseDoc);
    }

    return res.status(200).json({ ok: true, id: entityRef.id });
  } catch (err) {
    console.error('[ai/entityCreate] error:', err.message);
    return res.status(500).json({ error: 'Failed to create entity' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: grant subscription (temporary, remove after use)
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ALLOWED_UIDS = ['2MhVQ2hZD0cgDcYzxlHzhumml9l1'];

async function handleAdminGrant(req, res) {
  const { userId } = req.body ?? {};
  if (!ADMIN_ALLOWED_UIDS.includes(userId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { userId, plan, months } = req.body ?? {};
  if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });

  const now = new Date();
  const endDate = new Date(now);
  endDate.setMonth(endDate.getMonth() + (Number(months) || 1));

  const sub = {
    id: `admin-grant-${Date.now()}`,
    userId,
    plan,
    period: 'month',
    status: 'active',
    startDate: now.toISOString(),
    endDate: endDate.toISOString(),
    paymentMethod: 'admin',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await db.collection('subscriptions').doc(userId).set(sub);
  return res.json({ ok: true, sub });
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
      case 'report':        return await handleReport(req, res);
      case 'entityCreate':  return await handleEntityCreate(req, res);
      case 'adminGrant':    return await handleAdminGrant(req, res);
      default:
        return res.status(404).json({ error: `Unknown AI action: ${action}` });
    }
  } catch (err) {
    console.error(`[ai/${action}] unhandled error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
