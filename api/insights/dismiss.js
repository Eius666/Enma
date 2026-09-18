'use strict';

// POST /api/insights/dismiss
// Body: { fingerprint: string }
// Marks an insight as dismissed for the authenticated user.
// The insight doc's uid is verified before update — users cannot dismiss others' events.

const { admin }        = require('../_lib/firebaseAdmin');
const { dismissEvent } = require('../_lib/insights/store');

const FINGERPRINT_RE = /^[a-zA-Z0-9:.\-_]{1,120}$/;

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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const uid = await requireAuth(req);
  if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { fingerprint } = req.body || {};
  if (!fingerprint || typeof fingerprint !== 'string') {
    return res.status(400).json({ ok: false, error: 'fingerprint required' });
  }
  if (!FINGERPRINT_RE.test(fingerprint)) {
    return res.status(400).json({ ok: false, error: 'invalid fingerprint' });
  }

  try {
    const result = await dismissEvent(uid, fingerprint);
    if (result.result === 'forbidden') return res.status(403).json({ ok: false, error: 'forbidden' });
    if (result.result === 'not_found') return res.status(404).json({ ok: false, error: 'not_found' });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[INSIGHTS_DISMISS] uid=*** err:', err.message);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
