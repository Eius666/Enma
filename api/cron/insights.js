'use strict';

// ── Proactive Engine — Vercel Cron handler ────────────────────────────────────
//
// Scheduled: every hour via vercel.json crons.
// On-demand (data-change trigger): POST with ?uid=<uid>&domains=finance,tasks
//
// Auth: CRON_SECRET header or query param, or Vercel-signed cron request.

const { runAllUsers, runDetectorsForUser } = require('../_lib/insights/engine');

function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const headerAuth = req.headers.authorization === `Bearer ${secret}`;
  let querySecret  = '';
  try {
    const parsed = new URL(req.url || '/', 'https://placeholder.local');
    querySecret = parsed.searchParams.get('secret') || req.query?.secret || '';
  } catch {
    querySecret = req.query?.secret || '';
  }
  const isVercelCron = req.headers['user-agent'] === 'vercel-cron/1.0';
  return headerAuth || querySecret === secret || isVercelCron;
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const uid     = req.query?.uid;
  const domains = req.query?.domains
    ? req.query.domains.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;

  const t0 = Date.now();
  try {
    let result;
    if (uid) {
      // Single-user run for data-change trigger; uid comes from internal call only
      // (not from untrusted client — this endpoint is CRON_SECRET-protected)
      result = await runDetectorsForUser(uid, { domains });
    } else {
      result = await runAllUsers({ domains });
    }
    const duration = Date.now() - t0;
    console.log(`[PROACTIVE_ENGINE] cron_done duration=${duration}ms`, result);
    res.status(200).json({ ok: true, duration, ...result });
  } catch (err) {
    console.error('[PROACTIVE_ENGINE] fatal:', err.message, err.stack?.slice(0, 300));
    res.status(500).json({ ok: false, error: err.message });
  }
};
