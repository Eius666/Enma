'use strict';

// GET /api/insights/list
// Returns ranked active insights for the authenticated user.

const { admin }             = require('../_lib/firebaseAdmin');
const { loadActiveInsights, rankInsights } = require('../_lib/insights/store');

async function requireAuth(req) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const uid = await requireAuth(req);
  if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const insights = await loadActiveInsights(uid, 30);
    const ranked   = rankInsights(insights);
    return res.status(200).json({ ok: true, insights: ranked });
  } catch (err) {
    console.error('[INSIGHTS_LIST] uid=*** err:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
