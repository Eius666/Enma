'use strict';

const { admin, db }          = require('../_lib/firebaseAdmin');
const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const { calculateNextRun, getUserTimezone } = require('../_lib/tools');

const TELEGRAM_API = 'https://api.telegram.org';

const sendTelegramMessage = async (token, chatId, text) => {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok && payload.ok !== false, status: response.status, payload };
};

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    res.status(405).json({ ok: false, description: 'Method not allowed' });
    return;
  }

  // --- Rate limiting ---
  const ip = getClientIp(req);
  const limitMax = req.method === 'GET' ? 60 : 20;
  if (!await rateLimit(`cron:${ip}`, limitMax, 60 * 1000)) {
    res.status(429).json({ ok: false, description: 'Too many requests' });
    return;
  }

  // --- Cron authentication ---
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const header = req.headers?.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

    // Parse query directly from req.url — req.query is not always populated
    // in Vercel serverless functions outside of Next.js routing.
    let querySecret = '';
    try {
      const parsed = new URL(req.url || '/', 'https://placeholder.local');
      querySecret = parsed.searchParams.get('secret') || '';
    } catch (_) {
      querySecret = req.query?.secret || '';
    }

    const isVercelCron = req.headers['user-agent'] === 'vercel-cron/1.0';

    console.log('[cron] auth — bearer:', bearer ? 'set' : 'empty',
      '| querySecret:', querySecret ? 'set' : 'empty',
      '| req.query:', JSON.stringify(req.query),
      '| isVercelCron:', isVercelCron);

    if (!isVercelCron && bearer !== cronSecret && querySecret !== cronSecret) {
      console.warn('[cron] Unauthorized cron attempt');
      res.status(401).json({ ok: false, description: 'Unauthorized' });
      return;
    }
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, description: 'Missing TELEGRAM_BOT_TOKEN' });
    return;
  }

  try {
    const nowMs = Date.now();

    // Single equality filter only — no composite index needed.
    // scheduledAt comparison is done in-memory to handle both Firestore
    // Timestamps and ISO string values (created by older code).
    const snapshot = await db
      .collection('reminders')
      .where('status', '==', 'pending')
      .limit(200)
      .get();

    console.log('[cron] pending reminders in collection:', snapshot.size);

    const dueDocs = snapshot.docs.filter(d => {
      const s = d.data().scheduledAt;
      if (!s) return false;
      const ts = s.toDate ? s.toDate() : new Date(s);
      return !isNaN(ts.getTime()) && ts.getTime() <= nowMs;
    });

    console.log('[cron] due now:', dueDocs.length,
      '| skipped (future):', snapshot.size - dueDocs.length);

    const results = [];
    for (const docSnap of dueDocs) {
      const docRef = docSnap.ref;
      const data   = docSnap.data();

      console.log('[cron] processing reminder:', docRef.id,
        '| title:', data.title,
        '| chatId:', data.chatId,
        '| scheduledAt:', data.scheduledAt?.toDate?.()?.toISOString?.() ?? data.scheduledAt);

      const claimed = await db.runTransaction(async tx => {
        const latest = await tx.get(docRef);
        if (!latest.exists) return null;
        if (latest.data().status !== 'pending') return null;
        tx.update(docRef, {
          status:    'sending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return latest.data();
      });

      if (!claimed) {
        console.log('[cron] reminder', docRef.id, 'skipped — already claimed');
        continue;
      }

      if (!claimed.chatId) {
        console.error('[cron] reminder', docRef.id, 'has no chatId — skipping');
        await docRef.update({ status: 'failed', lastError: 'missing chatId',
          updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        results.push({ id: docRef.id, ok: false, error: 'missing chatId' });
        continue;
      }

      let text;
      if (claimed.telegramText) {
        text = claimed.telegramText;
      } else if (claimed.type === 'task_deadline') {
        text = `⏰ Напоминание: «${claimed.title}» через ${claimed.notifyBefore ?? 15} мин`;
      } else if (claimed.type === 'habit_reminder') {
        text = `🌱 Привычка: «${claimed.title}» — не забудь отметить сегодня!`;
      } else {
        text = `⏰ Напоминание: ${claimed.title}`;
      }

      const sendResult = await sendTelegramMessage(token, claimed.chatId, text);
      console.log('[cron] sendMessage to', claimed.chatId, '→ ok:', sendResult.ok,
        '| status:', sendResult.status,
        '| payload:', JSON.stringify(sendResult.payload).slice(0, 120));

      if (sendResult.ok) {
        await docRef.update({
          status:     'sent',
          notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await docRef.update({
          status:    'pending',
          lastError: sendResult.payload?.description ?? 'Telegram send failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      results.push({ id: docRef.id, ok: sendResult.ok, httpStatus: sendResult.status });
    }

    // ── [2] Automations ──────────────────────────────────────────────────────
    const autoSnap = await db
      .collection('automations')
      .where('status', '==', 'active')
      .limit(200)
      .get();

    const dueAutos = autoSnap.docs.filter(d => {
      const s = d.data().nextRunAt;
      if (!s) return false;
      const ts = s.toDate ? s.toDate() : new Date(s);
      return !isNaN(ts.getTime()) && ts.getTime() <= nowMs;
    });

    console.log('[cron] automations due:', dueAutos.length, '| total active:', autoSnap.size);

    const autoResults = [];
    for (const docSnap of dueAutos) {
      const a      = docSnap.data();
      const docRef = docSnap.ref;

      console.log('[cron] automation', docRef.id, '| name:', a.name, '| chatId:', a.chatId);

      try {
        const sendResult = await sendTelegramMessage(token, a.chatId, `⏰ ${a.name}\n\n${a.messageText}`);
        console.log('[cron] automation sendMessage → ok:', sendResult.ok);

        if (sendResult.ok) {
          const tz      = await getUserTimezone(a.userId).catch(() => 'Europe/Warsaw');
          const prevRun = a.nextRunAt?.toDate ? a.nextRunAt.toDate() : new Date(a.nextRunAt);
          const nextRun = calculateNextRun(a.scheduleType, a.scheduleData || {}, prevRun, tz);

          await docRef.update({
            lastRunAt: admin.firestore.Timestamp.fromDate(new Date(nowMs)),
            nextRunAt: admin.firestore.Timestamp.fromDate(nextRun),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log('[cron] automation', docRef.id, 'rescheduled →', nextRun.toISOString());
          autoResults.push({ id: docRef.id, ok: true });
        } else {
          console.error('[cron] automation', docRef.id, 'send failed:', sendResult.payload?.description);
          autoResults.push({ id: docRef.id, ok: false, error: sendResult.payload?.description });
        }
      } catch (autoErr) {
        console.error('[cron] automation', docRef.id, 'error:', autoErr.message);
        autoResults.push({ id: docRef.id, ok: false, error: autoErr.message });
      }
    }

    // ── [3] Cleanup stale pending reminders ─────────────────────────────────
    const cutoff    = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleSnap = await db
      .collection('reminders')
      .where('status', '==', 'pending')
      .where('scheduledAt', '<', cutoff)
      .limit(50)
      .get();

    let staleCount = 0;
    for (const doc of staleSnap.docs) {
      await doc.ref.delete();
      staleCount++;
    }
    if (staleCount > 0) console.log(`[cron] Cleaned ${staleCount} stale reminders`);

    res.status(200).json({
      ok: true,
      reminders: { processed: results.length, results },
      automations: { processed: autoResults.length, results: autoResults },
      staleRemindersDeleted: staleCount,
    });
  } catch (error) {
    console.error('[cron] ❌ execution error:', error.message, error.stack?.slice(0, 300));
    res.status(500).json({ ok: false, description: error.message });
  }
};
