'use strict';

// Diagnostic endpoint.
// Protected with CRON_SECRET (or open if CRON_SECRET not set, for dev convenience).
// Usage: GET /api/debug-ai?secret=<CRON_SECRET>
//        GET /api/debug-ai?secret=<CRON_SECRET>&type=reminders  — Firestore reminders

const { db } = require('./_lib/firebaseAdmin');

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

  // ── One-time cleanup of broken reminders ──────────────────────────────────
  if (req.query?.action === 'cleanup-reminders') {
    try {
      const snap   = await db.collection('reminders').limit(500).get();
      const now    = Date.now();
      const cutoff = now - 24 * 60 * 60 * 1000;
      const toDelete = [];

      for (const doc of snap.docs) {
        const d   = doc.data();
        const sAt = d.scheduledAt;

        if (!sAt) {
          toDelete.push({ id: doc.id, reason: 'null scheduledAt' });
          continue;
        }

        const ts = sAt.toDate ? sAt.toDate() : new Date(sAt);
        if (d.status === 'pending' && !isNaN(ts.getTime()) && ts.getTime() < cutoff) {
          toDelete.push({ id: doc.id, reason: 'stale pending >24h' });
        }
      }

      if (toDelete.length > 0) {
        const batch = db.batch();
        for (const { id } of toDelete) batch.delete(db.collection('reminders').doc(id));
        await batch.commit();
      }

      return res.status(200).json({ ok: true, cleaned: toDelete.length, details: toDelete });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Reminders debug mode ───────────────────────────────────────────────────
  if (req.query?.type === 'reminders') {
    try {
      const snap = await db.collection('reminders')
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get();

      const now  = new Date();
      const docs = snap.docs.map(d => {
        const data = d.data();
        const sAt  = data.scheduledAt;
        let scheduledAtIso  = null;
        let scheduledAtType = 'missing';
        let isDue           = false;

        if (sAt?.toDate) {
          scheduledAtIso  = sAt.toDate().toISOString();
          scheduledAtType = 'Firestore Timestamp';
          isDue           = sAt.toDate() <= now;
        } else if (sAt) {
          scheduledAtIso  = String(sAt);
          scheduledAtType = 'string';
          isDue           = new Date(sAt) <= now;
        }

        return {
          id: d.id,
          title:         data.title,
          status:        data.status,
          chatId:        data.chatId,
          telegramText:  data.telegramText,
          scheduledAt:   scheduledAtIso,
          scheduledAtType,
          isDue,
          lastError:     data.lastError,
          createdAt:     data.createdAt?.toDate?.()?.toISOString?.() ?? null,
        };
      });

      const byStatus = {};
      for (const d of docs) byStatus[d.status] = (byStatus[d.status] || 0) + 1;

      return res.status(200).json({
        ok: true, serverNow: now.toISOString(), total: docs.length, byStatus, docs,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
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

  // ── Telegram webhook info ──────────────────────────────────────────────────
  let telegramInfo = null;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (botToken) {
    try {
      const [meResp, whResp] = await Promise.all([
        fetch(`https://api.telegram.org/bot${botToken}/getMe`),
        fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
      ]);
      const me = await meResp.json();
      const wh = await whResp.json();
      telegramInfo = {
        bot_username:          me.result?.username,
        bot_id:                me.result?.id,
        webhook_url:           wh.result?.url || '(not set)',
        pending_updates:       wh.result?.pending_update_count ?? 0,
        last_error_date:       wh.result?.last_error_date
          ? new Date(wh.result.last_error_date * 1000).toISOString()
          : null,
        last_error_message:    wh.result?.last_error_message || null,
        max_connections:       wh.result?.max_connections,
        allowed_updates:       wh.result?.allowed_updates,
      };
    } catch (err) {
      telegramInfo = { error: err.message };
    }
  }

  const anyOk = modelResults.some(r => r.ok);
  res.status(200).json({ ok: anyOk, env: envReport, models: modelResults, telegram: telegramInfo });
};
