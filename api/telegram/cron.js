'use strict';

const { admin, db }          = require('../_lib/firebaseAdmin');
const { rateLimit, getClientIp } = require('../_lib/rateLimit');
const { calculateNextRun, getUserTimezone } = require('../_lib/tools');
const { isHabitDueToday } = require('../_lib/habits/habitSchedule');
const { processDueReminders } = require('../_lib/reminders/deliver');
const { getEnvName, isChatAllowed } = require('../_lib/envIsolation');
const crypto = require('crypto');

const TELEGRAM_API = 'https://api.telegram.org';

const sendTelegramMessage = async (token, chatId, text) => {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
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
  if (!cronSecret && getEnvName() === 'dev') {
    // DEV fails closed: an unset secret must never leave this endpoint open.
    res.status(503).json({ ok: false, description: 'CRON_SECRET_NOT_CONFIGURED' });
    return;
  }
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

    // Constant-time comparison. A request is NOT trusted because of its
    // User-Agent (that header is client-controlled); Vercel's own cron sends
    // the same Bearer secret.
    const same = (a, b) => {
      const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    if (!same(bearer, cronSecret) && !same(querySecret, cronSecret)) {
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

    // ── [1] Reminders ──────────────────────────────────────────────────────
    // See api/_lib/reminders/deliver.js for the lifecycle and the delivery
    // guarantees (at-least-once, bounded attempts, leases, expiry instead of
    // deletion, recipient checked against the owning user).
    const reminderStats = await processDueReminders({
      db,
      serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
      fromMillis: ms => admin.firestore.Timestamp.fromMillis(ms),
      send: (chatId, text) => sendTelegramMessage(token, chatId, text),
      isRecipientAllowed: chatId => isChatAllowed(chatId),
      // Last-moment re-validation of habit reminders: a habit archived, deleted,
      // disabled or rescheduled after materialization must not get a stale send.
      shouldSkip: async claimed => {
        if (claimed.type !== 'habit_reminder' || !claimed.habitId) return null;
        let stillDue = true;
        try {
          const habitSnap = await db.collection('habits').doc(claimed.habitId).get();
          const habit = habitSnap.exists ? habitSnap.data() : null;
          const tz = await getUserTimezone(claimed.userId);
          stillDue = isHabitDueToday(habit, tz);
        } catch (err) {
          // Cannot confirm either way — fail open and send rather than lose a real reminder.
          stillDue = true;
        }
        return stillDue ? null : { status: 'cancelled', reason: 'habit_no_longer_due' };
      },
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });

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

      console.log('[cron] automation', docRef.id);

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

    // Unsent reminders are never deleted here: those that missed their window
    // are marked `expired` by processDueReminders and stay inspectable.
    res.status(200).json({
      ok: true,
      reminders: reminderStats,
      automations: { processed: autoResults.length, results: autoResults },
    });
  } catch (error) {
    console.error('[cron] ❌ execution error:', error.message, error.stack?.slice(0, 300));
    res.status(500).json({ ok: false, description: error.message });
  }
};
